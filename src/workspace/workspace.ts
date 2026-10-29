import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_LIMITS = Object.freeze({
  fileBytes: 64 * 1024,
  outputBytes: 16 * 1024,
  entries: 200,
  visited: 1000,
  depth: 8,
  searchBytes: 1024 * 1024,
  matches: 100,
  changes: 64,
  grants: 128,
  pathLength: 1024,
});

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceChange {
  path: string;
  kind: "created" | "modified";
  before: string;
  after: string;
}

export interface WorkspaceRead {
  path: string;
  text: string;
  version: string;
  offset: number;
  totalLines: number;
  truncated: boolean;
}

export interface WorkspaceList {
  path: string;
  entries: { path: string; kind: "file" | "directory" | "excluded" }[];
  excluded: number;
  truncated: boolean;
}

export interface WorkspaceSearch {
  matches: { path: string; line?: number; text?: string }[];
  excluded: number;
  visited: number;
  bytesRead: number;
  truncated: boolean;
}

type Snapshot = { text: string; version: string; identity: string };

const fail = (code: string, message: string): never => {
  throw new WorkspaceError(code, message);
};
const check = (signal?: AbortSignal) => signal?.throwIfAborted();
const identity = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}:${stat.nlink}`;
const versionOf = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function excluded(name: string): boolean {
  return (
    /^(?:\.git|node_modules|dist|\.ssh|\.aws|\.azure|\.gnupg|certs?|keys?|secrets?|credentials?)(?:$|\.)/i.test(
      name,
    ) ||
    /^\.env(?:$|\.)/i.test(name) ||
    /^(?:\.npmrc|\.netrc|\.pypirc|\.mcp\.json|id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|known_hosts)$/i.test(
      name,
    ) ||
    /(?:^|[._-])(?:private|secret|credentials?|keys?|cert(?:ificate)?s?)(?:[._-]|$)/i.test(name) ||
    /\.(?:key|pem|crt|cer|cert|pfx|p12|p7b|jks|keystore)$/i.test(name) ||
    /^\.lore-/i.test(name)
  );
}

function relative(input: string, allowRoot = false): string {
  if (typeof input !== "string" || input.length > WORKSPACE_LIMITS.pathLength) {
    return fail("INVALID_PATH", "Use a bounded relative workspace path.");
  }
  if (allowRoot && input === ".") return ".";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in untrusted paths.
  if (!input || /^[\\/]/.test(input) || /[:\x00-\x1f\x7f<>"|?*]/.test(input)) {
    return fail(
      "INVALID_PATH",
      "Only relative paths without drive, UNC, or stream syntax are allowed.",
    );
  }
  const parts = input.replaceAll("\\", "/").split("/");
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    )
      return fail(
        "INVALID_PATH",
        "Traversal, device names, and trailing dots or spaces are forbidden.",
      );
    if (excluded(part)) return fail("EXCLUDED", "This path is excluded from workspace access.");
  }
  return parts.join("/");
}

function safeFile(stat: Stats): void {
  if (stat.isSymbolicLink()) fail("LINK_FORBIDDEN", "Links and junctions are forbidden.");
  if (!stat.isFile()) fail("NOT_TEXT_FILE", "The target must be a regular text file.");
  if (stat.nlink !== 1) fail("LINK_FORBIDDEN", "Hard-linked files are forbidden.");
  if (stat.size > WORKSPACE_LIMITS.fileBytes)
    fail("FILE_TOO_LARGE", "Files are limited to 64 KiB.");
}

function encode(text: string): Buffer {
  if (
    typeof text !== "string" ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
  )
    fail("INVALID_TEXT", "Text must be valid UTF-8.");
  const data = Buffer.from(text, "utf8");
  if (data.length > WORKSPACE_LIMITS.fileBytes)
    fail("FILE_TOO_LARGE", "Files are limited to 64 KiB.");
  decode(data);
  return data;
}

function decode(data: Uint8Array): string {
  let text: string;
  try {
    // ignoreBOM preserves the original BOM as U+FEFF for byte-faithful edits.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return fail("INVALID_TEXT", "Only strictly valid UTF-8 text is supported.");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional binary/control-byte detection.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    fail("BINARY_FILE", "Binary files are not supported.");
  }
  return text;
}

/**
 * Application-level filesystem boundary, not an OS sandbox. Checks and file
 * descriptors reject ordinary links/replacements; portable Node APIs cannot
 * eliminate races with a malicious local process swapping ancestors between
 * validation and open/rename. Do not expose this to hostile local writers.
 * Writes within this Workspace are serialized. Keep one Workspace per session.
 */
export class Workspace {
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    const done = () => {
      this.pending.delete(operation);
    };
    void operation.then(done, done);
    return operation;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  list(input = ".", signal?: AbortSignal): Promise<WorkspaceList> {
    return this.track(this.listInternal(input, signal));
  }

  read(input: string, offset = 0, limit = 65536, signal?: AbortSignal): Promise<WorkspaceRead> {
    return this.track(this.readInternal(input, offset, limit, signal));
  }

  search(
    query: string,
    mode: "name" | "content",
    input = ".",
    signal?: AbortSignal,
  ): Promise<WorkspaceSearch> {
    return this.track(this.searchInternal(query, mode, input, signal));
  }

  create(
    input: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; version: string; kind: "created" }> {
    return this.track(this.createInternal(input, content, signal));
  }

  edit(
    input: string,
    oldText: string,
    newText: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; version: string; kind: "modified" }> {
    return this.track(this.editInternal(input, oldText, newText, version, signal));
  }
  private readonly journal: WorkspaceChange[] = [];
  private readonly grants = new Map<string, { version: string; identity: string }>();

  private constructor(
    readonly root: string,
    private readonly rootIdentity: string,
  ) {}

  static async open(root: string): Promise<Workspace> {
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      /^[\\/]{2}/.test(root) ||
      (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(root) || root.slice(2).includes(":")))
    ) {
      return fail("INVALID_ROOT", "Select an absolute local workspace directory.");
    }
    // Validate the supplied spelling before resolve can erase a linked ancestor/.. .
    if (root.split(/[\\/]/).includes("..")) fail("INVALID_ROOT", "Root traversal is forbidden.");
    const resolved = path.resolve(root);
    await Workspace.checkAncestors(resolved);
    const stat = await lstat(resolved);
    if (!stat.isDirectory()) fail("INVALID_ROOT", "Workspace root must be a directory.");
    return new Workspace(resolved, `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
  }

  get changes(): readonly WorkspaceChange[] {
    return this.journal.map((change) => ({ ...change }));
  }

  resetChanges(): void {
    this.journal.length = 0;
  }

  takeChanges(): WorkspaceChange[] {
    const result = this.journal.splice(0);
    return result;
  }

  private static async checkAncestors(target: string): Promise<void> {
    const base = path.parse(target).root;
    const pieces = path.relative(base, target).split(path.sep).filter(Boolean);
    let current = base;
    for (const piece of ["", ...pieces]) {
      current = piece ? path.join(current, piece) : current;
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        fail("LINK_FORBIDDEN", "Links and junctions are forbidden, including root ancestors.");
      if (!samePath(await realpath(current), current)) {
        fail("LINK_FORBIDDEN", "Aliased filesystem paths are forbidden.");
      }
    }
  }

  private async target(input: string, missing = false, allowRoot = false): Promise<string> {
    const rel = relative(input, allowRoot);
    await Workspace.checkAncestors(this.root);
    const rootStat = await lstat(this.root);
    if (`${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeMs}` !== this.rootIdentity) {
      fail("CONFLICT", "Workspace root changed; select it again.");
    }
    let current = this.root;
    const parts = rel === "." ? [] : rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i] as string);
      let stat: Stats;
      try {
        stat = await lstat(current);
      } catch (error) {
        if (missing && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT")
          return current;
        throw error;
      }
      if (stat.isSymbolicLink() || !samePath(await realpath(current), current)) {
        fail("LINK_FORBIDDEN", "Links and junctions are forbidden.");
      }
      if (i < parts.length - 1 && !stat.isDirectory())
        fail("INVALID_PATH", "A parent is not a directory.");
      if (stat.isFile() && stat.nlink !== 1)
        fail("LINK_FORBIDDEN", "Hard-linked files are forbidden.");
    }
    return current;
  }

  private async snapshot(input: string, signal?: AbortSignal): Promise<Snapshot> {
    check(signal);
    const target = await this.target(input);
    const before = await lstat(target);
    safeFile(before);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      safeFile(stat);
      if (identity(before) !== identity(stat))
        fail("CONFLICT", "File changed while opening; read it again.");
      const buffer = Buffer.alloc(WORKSPACE_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        check(signal);
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      check(signal);
      if (length > WORKSPACE_LIMITS.fileBytes)
        fail("FILE_TOO_LARGE", "Files are limited to 64 KiB.");
      const after = await handle.stat();
      const current = await lstat(await this.target(input));
      if (identity(stat) !== identity(after) || identity(after) !== identity(current)) {
        fail("CONFLICT", "File changed while reading; read it again.");
      }
      const data = buffer.subarray(0, length);
      return { text: decode(data), version: versionOf(data), identity: identity(after) };
    } finally {
      await handle.close();
    }
  }

  private async readInternal(
    input: string,
    offset = 0,
    limit = 65536,
    signal?: AbortSignal,
  ): Promise<WorkspaceRead> {
    const rel = relative(input);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    ) {
      fail("INVALID_RANGE", "Use a nonnegative line offset and a limit from 1 to 65536.");
    }
    const snapshot = await this.snapshot(rel, signal);
    const lines = snapshot.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const text = lines.slice(offset, offset + limit).join("");
    const truncated = offset !== 0 || offset + limit < lines.length;
    if (!truncated) {
      this.grants.delete(rel);
      this.grants.set(rel, { version: snapshot.version, identity: snapshot.identity });
      if (this.grants.size > WORKSPACE_LIMITS.grants)
        this.grants.delete(this.grants.keys().next().value as string);
    }
    return {
      path: rel,
      text,
      version: snapshot.version,
      offset,
      totalLines: lines.length,
      truncated,
    };
  }

  private async listInternal(input = ".", signal?: AbortSignal): Promise<WorkspaceList> {
    check(signal);
    const rel = relative(input, true);
    const directory = await this.target(rel, false, true);
    if (!(await lstat(directory)).isDirectory())
      fail("NOT_DIRECTORY", "List requires a directory.");
    const result: WorkspaceList = { path: rel, entries: [], excluded: 0, truncated: false };
    let bytes = 0;
    let visited = 0;
    const dir = await opendir(directory);
    for await (const entry of dir) {
      check(signal);
      if (++visited > WORKSPACE_LIMITS.entries) {
        result.truncated = true;
        break;
      }
      const child = rel === "." ? entry.name : `${rel}/${entry.name}`;
      let kind: "file" | "directory" | "excluded" = "excluded";
      try {
        const stat = await lstat(await this.target(child));
        if (stat.isDirectory()) kind = "directory";
        else {
          safeFile(stat);
          kind = "file";
        }
      } catch {
        kind = "excluded";
      }
      const item = { path: child, kind };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > WORKSPACE_LIMITS.outputBytes) {
        result.truncated = true;
        break;
      }
      bytes += size;
      if (kind === "excluded") result.excluded++;
      result.entries.push(item);
    }
    check(signal);
    return result;
  }

  private async searchInternal(
    query: string,
    mode: "name" | "content",
    input = ".",
    signal?: AbortSignal,
  ): Promise<WorkspaceSearch> {
    check(signal);
    if (!query || query.length > 200 || (mode !== "name" && mode !== "content"))
      fail("INVALID_QUERY", "Use a literal query of 1–200 characters and name/content mode.");
    const rel = relative(input, true);
    const start = await this.target(rel, false, true);
    if (!(await lstat(start)).isDirectory()) fail("NOT_DIRECTORY", "Search requires a directory.");
    const result: WorkspaceSearch = {
      matches: [],
      excluded: 0,
      visited: 0,
      bytesRead: 0,
      truncated: false,
    };
    let outputBytes = 0;
    const stack = [{ rel, depth: 0 }];
    const add = (match: WorkspaceSearch["matches"][number]) => {
      const bytes = Buffer.byteLength(JSON.stringify(match));
      if (
        result.matches.length >= WORKSPACE_LIMITS.matches ||
        outputBytes + bytes > WORKSPACE_LIMITS.outputBytes
      ) {
        result.truncated = true;
        return false;
      }
      result.matches.push(match);
      outputBytes += bytes;
      return true;
    };
    while (stack.length && !result.truncated) {
      check(signal);
      const current = stack.pop() as { rel: string; depth: number };
      const dir = await opendir(await this.target(current.rel, false, true));
      for await (const entry of dir) {
        check(signal);
        if (result.visited >= WORKSPACE_LIMITS.visited) {
          result.truncated = true;
          break;
        }
        result.visited++;
        const child = current.rel === "." ? entry.name : `${current.rel}/${entry.name}`;
        let stat: Stats;
        try {
          stat = await lstat(await this.target(child));
        } catch {
          result.excluded++;
          continue;
        }
        if (mode === "name" && entry.name.toLowerCase().includes(query.toLowerCase())) {
          if (!add({ path: child })) break;
        }
        if (stat.isDirectory()) {
          if (current.depth >= WORKSPACE_LIMITS.depth) result.truncated = true;
          else stack.push({ rel: child, depth: current.depth + 1 });
          continue;
        }
        if (mode === "name") continue;
        try {
          safeFile(stat);
        } catch {
          result.excluded++;
          continue;
        }
        // Reserve the maximum per-file read, including growth after the metadata check.
        if (result.bytesRead + WORKSPACE_LIMITS.fileBytes > WORKSPACE_LIMITS.searchBytes) {
          result.truncated = true;
          break;
        }
        result.bytesRead += WORKSPACE_LIMITS.fileBytes;
        let text: string;
        try {
          text = (await this.snapshot(child, signal)).text;
        } catch (error) {
          check(signal);
          if ((error as Error).name === "AbortError") throw error;
          result.excluded++;
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          check(signal);
          const line = lines[i] as string;
          const index = line.indexOf(query);
          if (
            index >= 0 &&
            !add({
              path: child,
              line: i + 1,
              text: line.slice(Math.max(0, index - 60), index + 240),
            })
          )
            break;
        }
        if (result.truncated) break;
      }
    }
    check(signal);
    return result;
  }

  private async write<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      check(signal);
      if (this.journal.length >= WORKSPACE_LIMITS.changes)
        fail("CHANGE_LIMIT", "Change journal is full; start a new run before writing more files.");
      return await action();
    } finally {
      release();
    }
  }

  private async createInternal(
    input: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; version: string; kind: "created" }> {
    return this.write(async () => {
      const rel = relative(input);
      const data = encode(content);
      const target = await this.target(rel, true);
      check(signal);
      const handle = await open(target, "wx", 0o600);
      let completed = false;
      let createdIdentity: string | undefined;
      try {
        createdIdentity = identity(await handle.stat());
        await handle.writeFile(data);
        await handle.sync();
        completed = true;
        this.journal.push({ path: rel, kind: "created", before: "", after: content });
        this.grants.delete(rel);
      } finally {
        const own = await handle.stat();
        await handle.close();
        if (!completed) {
          // Only remove our own incomplete inode; never remove a replacement.
          const current = await lstat(target).catch(() => undefined);
          if (createdIdentity !== undefined && current && identity(current) === identity(own))
            await unlink(target);
        }
      }
      return { path: rel, version: versionOf(data), kind: "created" };
    }, signal);
  }

  private async editInternal(
    input: string,
    oldText: string,
    newText: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; version: string; kind: "modified" }> {
    return this.write(async () => {
      const rel = relative(input);
      const grant = this.grants.get(rel);
      if (!grant || grant.version !== version)
        return fail("READ_REQUIRED", "Read the complete file and use its version before editing.");
      if (!oldText) fail("INVALID_EDIT", "oldText must be nonempty and match exactly once.");
      const before = await this.snapshot(rel, signal);
      if (before.version !== version || before.identity !== grant.identity)
        fail("CONFLICT", "File changed since the full read; read it again.");
      const index = before.text.indexOf(oldText);
      if (index < 0) fail("NO_MATCH", "oldText does not occur in the current file.");
      if (before.text.indexOf(oldText, index + 1) >= 0)
        fail("AMBIGUOUS_MATCH", "oldText occurs more than once; provide a unique match.");
      const end = index + oldText.length;
      if (
        (index > 0 && before.text[index - 1] === "\r" && before.text[index] === "\n") ||
        (end > 0 && before.text[end - 1] === "\r" && before.text[end] === "\n")
      ) {
        fail("INVALID_EDIT", "Include complete CRLF pairs in oldText.");
      }
      // Preserve an existing CRLF convention for replacement text, without
      // normalizing untouched bytes or lone LF files. BOM cannot be removed.
      const replacement = before.text.includes("\r\n")
        ? newText.replace(/\r?\n/g, "\r\n")
        : newText;
      const after =
        before.text.slice(0, index) + replacement + before.text.slice(index + oldText.length);
      if (before.text.startsWith("﻿") && !after.startsWith("﻿"))
        fail("INVALID_EDIT", "Preserve the original UTF-8 BOM.");
      const data = encode(after);
      const target = await this.target(rel);
      const temporary = path.join(path.dirname(target), `.lore-${randomUUID()}.tmp`);
      let tempCreated = false;
      try {
        check(signal);
        const handle = await open(temporary, "wx", 0o600);
        tempCreated = true;
        try {
          await handle.writeFile(data);
          await handle.chmod((await lstat(target)).mode & 0o777);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const current = await this.snapshot(rel, signal);
        if (current.version !== before.version || current.identity !== before.identity)
          fail("CONFLICT", "File changed before write; read it again.");
        check(signal);
        await this.target(rel);
        check(signal);
        await rename(temporary, target);
        tempCreated = false;
        // Never check cancellation between commit and journaling.
        this.journal.push({ path: rel, kind: "modified", before: before.text, after });
        this.grants.delete(rel);
      } finally {
        if (tempCreated) await unlink(temporary).catch(() => {});
      }
      return { path: rel, version: versionOf(data), kind: "modified" };
    }, signal);
  }
}
