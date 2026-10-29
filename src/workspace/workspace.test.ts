import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_LIMITS, Workspace } from "./workspace.js";

let root: string;
let workspace: Workspace;
const cleanup: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lore-workspace-"));
  cleanup.push(root);
  workspace = await Workspace.open(root);
});
afterEach(async () => {
  await workspace.drain();
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function file(name: string, content: string | Buffer) {
  await writeFile(path.join(root, name), content);
}

describe("workspace boundary", () => {
  it.each([
    "../outside",
    "a/../../outside",
    "a/../inside",
    "/absolute",
    "\\absolute",
    "C:\\outside",
    "C:relative",
    "D:/other",
    "//server/share",
    "\\\\server\\share",
    "file.txt:secret",
    "CON",
    "con.txt",
    "AUX",
    "NUL.md",
    "com1.txt",
    "LPT9",
    "COM¹",
    "CONIN$",
    "bad.",
    "bad ",
    "a//b",
    "./a",
    "a\u0000b",
    "a?b",
    "a|b",
  ])("rejects Windows and traversal syntax %j", async (input) => {
    await expect(workspace.read(input)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(workspace.create(input, "x")).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it.each([
    ".env",
    ".env.local",
    "node_modules/x",
    "dist/x",
    ".git/config",
    "private.key",
    "api-key.txt",
    "server-cert.txt",
    "certs/root.crt",
    "id_ed25519",
    "secrets.json",
    ".npmrc",
    ".mcp.json",
  ])("excludes sensitive path %j", async (input) => {
    await expect(workspace.create(input, "secret")).rejects.toMatchObject({ code: "EXCLUDED" });
  });

  it("refuses actual directory junctions including a root alias and ancestor alias", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "lore-outside-"));
    cleanup.push(external);
    await writeFile(path.join(external, "outside.txt"), "private");
    await mkdir(path.join(external, "nested"));
    await symlink(
      external,
      path.join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(workspace.read("alias/outside.txt")).rejects.toMatchObject({
      code: "LINK_FORBIDDEN",
    });
    await expect(workspace.create("alias/created.txt", "x")).rejects.toMatchObject({
      code: "LINK_FORBIDDEN",
    });
    await expect(Workspace.open(path.join(root, "alias"))).rejects.toMatchObject({
      code: "LINK_FORBIDDEN",
    });
    await expect(Workspace.open(path.join(root, "alias", "nested"))).rejects.toMatchObject({
      code: "LINK_FORBIDDEN",
    });
    const listed = await workspace.list();
    expect(listed.entries).toContainEqual({ path: "alias", kind: "excluded" });
    expect(listed.excluded).toBe(1);
  });

  it("refuses file symlinks when the host permits their creation", async (context) => {
    await file("original.txt", "text");
    try {
      await symlink(path.join(root, "original.txt"), path.join(root, "alias.txt"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(workspace.read("alias.txt")).rejects.toMatchObject({ code: "LINK_FORBIDDEN" });
  });

  it("rejects hardlinks, including a link introduced after the read", async () => {
    await file("original.txt", "text");
    const version = (await workspace.read("original.txt")).version;
    await link(path.join(root, "original.txt"), path.join(root, "linked.txt"));
    await expect(workspace.read("linked.txt")).rejects.toMatchObject({ code: "LINK_FORBIDDEN" });
    await expect(workspace.edit("original.txt", "text", "new", version)).rejects.toMatchObject({
      code: "LINK_FORBIDDEN",
    });
    expect((await workspace.list()).excluded).toBe(2);
  });

  it("rejects workspace root replacement after opening", async () => {
    const moved = `${root}-moved`;
    cleanup.push(moved);
    await rename(root, moved);
    await mkdir(root);
    await expect(workspace.list()).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("text reads and edits", () => {
  it("preserves BOM and CRLF and uses zero-based line windows", async () => {
    await file("notes.txt", "\uFEFFfirst\r\nsecond\r\nthird\r\n");
    const partial = await workspace.read("notes.txt", 1, 1);
    expect(partial).toMatchObject({ text: "second\r\n", truncated: true, totalLines: 3 });
    await expect(
      workspace.edit("notes.txt", "second", "next", partial.version),
    ).rejects.toMatchObject({ code: "READ_REQUIRED" });
    const full = await workspace.read("notes.txt");
    expect(full.text.startsWith("\uFEFF")).toBe(true);
    expect(full.truncated).toBe(false);
    await workspace.edit("notes.txt", "second", "next\nline", full.version);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe(
      "\uFEFFfirst\r\nnext\r\nline\r\nthird\r\n",
    );
    expect(workspace.changes).toEqual([
      {
        path: "notes.txt",
        kind: "modified",
        before: full.text,
        after: "\uFEFFfirst\r\nnext\r\nline\r\nthird\r\n",
      },
    ]);
  });

  it("rejects invalid UTF-8 and binary without changing them", async () => {
    await file("invalid.txt", Buffer.from([0xc3, 0x28]));
    await file("binary.txt", Buffer.from([0x61, 0, 0x62]));
    await expect(workspace.read("invalid.txt")).rejects.toMatchObject({ code: "INVALID_TEXT" });
    await expect(workspace.read("binary.txt")).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(workspace.create("bad.txt", "\ud800")).rejects.toMatchObject({
      code: "INVALID_TEXT",
    });
    expect((await workspace.search("a", "content")).excluded).toBe(2);
  });

  it("requires a complete prior read and refuses stale versions, missing and ambiguous matches", async () => {
    await file("notes.txt", "one one");
    await expect(workspace.edit("notes.txt", "one", "two", "x".repeat(64))).rejects.toMatchObject({
      code: "READ_REQUIRED",
    });
    const version = (await workspace.read("notes.txt")).version;
    await expect(workspace.edit("notes.txt", "one", "two", version)).rejects.toMatchObject({
      code: "AMBIGUOUS_MATCH",
    });
    await expect(workspace.edit("notes.txt", "absent", "two", version)).rejects.toMatchObject({
      code: "NO_MATCH",
    });
    await file("notes.txt", "user change");
    await expect(workspace.edit("notes.txt", "one one", "two", version)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(workspace.changes).toEqual([]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("user change");
  });

  it("detects replacement with identical bytes using file identity", async () => {
    await file("notes.txt", "same bytes");
    const version = (await workspace.read("notes.txt")).version;
    await file("replacement.txt", "same bytes");
    await unlink(path.join(root, "notes.txt"));
    await rename(path.join(root, "replacement.txt"), path.join(root, "notes.txt"));
    await expect(workspace.edit("notes.txt", "same", "other", version)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses replacements splitting a CRLF pair", async () => {
    await file("notes.txt", "first\r\nsecond");
    const { version } = await workspace.read("notes.txt");
    await expect(workspace.edit("notes.txt", "\n", "\n", version)).rejects.toMatchObject({
      code: "INVALID_EDIT",
    });
    await expect(workspace.edit("notes.txt", "\r", "", version)).rejects.toMatchObject({
      code: "INVALID_EDIT",
    });
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("first\r\nsecond");
  });

  it("does not permit removing the original BOM", async () => {
    await file("notes.txt", "\uFEFFtext");
    const { version } = await workspace.read("notes.txt");
    await expect(workspace.edit("notes.txt", "\uFEFF", "", version)).rejects.toMatchObject({
      code: "INVALID_EDIT",
    });
  });

  it("bounds files and the resulting edit size", async () => {
    await file("large.txt", "x".repeat(WORKSPACE_LIMITS.fileBytes + 1));
    await expect(workspace.read("large.txt")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      workspace.create("large-new.txt", "x".repeat(WORKSPACE_LIMITS.fileBytes + 1)),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await file("exact.txt", "x".repeat(WORKSPACE_LIMITS.fileBytes));
    const full = await workspace.read("exact.txt");
    expect(Buffer.byteLength(full.text)).toBe(WORKSPACE_LIMITS.fileBytes);
    await expect(
      workspace.edit("exact.txt", full.text, `${full.text}x`, full.version),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

describe("bounded traversal", () => {
  it("makes exclusions visible and supports name/content searches", async () => {
    await mkdir(path.join(root, "nested"));
    await file("nested/hello.txt", "first\nneedle here\nlast");
    await file(".env", "needle secret");
    await mkdir(path.join(root, "node_modules"));
    await file("node_modules/a.txt", "needle");
    expect((await workspace.list()).excluded).toBe(2);
    const names = await workspace.search("hello", "name");
    expect(names.matches).toEqual([{ path: "nested/hello.txt" }]);
    const contents = await workspace.search("needle", "content");
    expect(contents.matches).toEqual([{ path: "nested/hello.txt", line: 2, text: "needle here" }]);
    expect(contents.excluded).toBe(2);
  });

  it("caps listing count and search traversal metadata", async () => {
    await Promise.all(
      Array.from({ length: WORKSPACE_LIMITS.visited + 5 }, (_, i) => file(`file-${i}.txt`, "")),
    );
    const listed = await workspace.list();
    expect(listed.entries.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.entries);
    expect(listed.truncated).toBe(true);
    const searched = await workspace.search("not-found", "name");
    expect(searched.visited).toBe(WORKSPACE_LIMITS.visited);
    expect(searched.truncated).toBe(true);
  }, 20000);

  it("caps matches, snippets and search byte budget", async () => {
    await file("matches.txt", "needle\n".repeat(200));
    const result = await workspace.search("needle", "content");
    expect(result.matches).toHaveLength(WORKSPACE_LIMITS.matches);
    expect(result.truncated).toBe(true);
    await unlink(path.join(root, "matches.txt"));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        file(`${i}.txt`, "x".repeat(WORKSPACE_LIMITS.fileBytes)),
      ),
    );
    const bytes = await workspace.search("not-found", "content");
    expect(bytes.bytesRead).toBeLessThanOrEqual(WORKSPACE_LIMITS.searchBytes);
    expect(bytes.truncated).toBe(true);
  });

  it("reports depth exhaustion", async () => {
    let nested = root;
    for (let i = 0; i < WORKSPACE_LIMITS.depth + 2; i++) {
      nested = path.join(nested, "nested");
      await mkdir(nested);
    }
    expect((await workspace.search("absent", "name")).truncated).toBe(true);
  });
});

describe("serialized writes, cancellation and journal", () => {
  it("creates exclusively and serializes conflicting writes in call order", async () => {
    const first = workspace.create("new.txt", "first");
    const second = workspace.create("new.txt", "second");
    await expect(first).resolves.toMatchObject({ kind: "created" });
    await expect(second).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("first");
    const version = (await workspace.read("new.txt")).version;
    const edits = await Promise.allSettled([
      workspace.edit("new.txt", "first", "edited", version),
      workspace.edit("new.txt", "first", "overwritten", version),
    ]);
    expect(edits.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("edited");
    expect(await readdir(root)).toEqual(["new.txt"]);
    const copy = workspace.changes;
    if (copy[0]) copy[0].after = "mutated";
    expect(workspace.changes[0]?.after).toBe("first");
  });

  it("checks cancellation inside the write lock and drains without discarding completed writes", async () => {
    const first = workspace.create("kept.txt", "completed");
    const controller = new AbortController();
    const second = workspace.create("cancelled.txt", "never", controller.signal);
    const outcome = Promise.allSettled([first, second]);
    controller.abort();
    await workspace.drain();
    const results = await outcome;
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readdir(root)).toEqual(["kept.txt"]);
    expect(workspace.changes).toEqual([
      { path: "kept.txt", kind: "created", before: "", after: "completed" },
    ]);
    expect(workspace.takeChanges()).toHaveLength(1);
    expect(workspace.changes).toEqual([]);
  });

  it("cleans staged edit files on cancellation and late external conflicts", async () => {
    await file("notes.txt", "original");
    const controller = new AbortController();
    const { version } = await workspace.read("notes.txt");
    const internal = workspace as unknown as {
      snapshot(
        input: string,
        signal?: AbortSignal,
      ): Promise<{ text: string; version: string; identity: string }>;
    };
    const snapshot = internal.snapshot.bind(workspace);
    let calls = 0;
    const spy = vi.spyOn(internal, "snapshot").mockImplementation(async (...args) => {
      const value = await snapshot(...args);
      if (++calls === 2) controller.abort();
      return value;
    });
    await expect(
      workspace.edit("notes.txt", "original", "cancelled", version, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(root)).toEqual(["notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("original");
    expect(workspace.changes).toEqual([]);
    spy.mockRestore();

    calls = 0;
    vi.spyOn(internal, "snapshot").mockImplementation(async (...args) => {
      if (++calls === 2) await file("notes.txt", "external change");
      return snapshot(...args);
    });
    await expect(
      workspace.edit("notes.txt", "original", "replaced", version),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(root)).toEqual(["notes.txt"]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("external change");
    expect(workspace.changes).toEqual([]);
  });

  it("aborts reads and traversal and prevents pre-aborted create/edit", async () => {
    await file("notes.txt", "text");
    const { version } = await workspace.read("notes.txt");
    const signal = AbortSignal.abort();
    for (const action of [
      () => workspace.read("notes.txt", 0, 1, signal),
      () => workspace.list(".", signal),
      () => workspace.search("text", "content", ".", signal),
      () => workspace.create("new.txt", "x", signal),
      () => workspace.edit("notes.txt", "text", "new", version, signal),
    ])
      await expect(action()).rejects.toMatchObject({ name: "AbortError" });
    expect(workspace.changes).toEqual([]);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("text");
  });

  it("bounds journal memory and supports explicit per-run reset", async () => {
    for (let i = 0; i < WORKSPACE_LIMITS.changes; i++) await workspace.create(`${i}.txt`, "x");
    await expect(workspace.create("blocked.txt", "x")).rejects.toMatchObject({
      code: "CHANGE_LIMIT",
    });
    workspace.resetChanges();
    await expect(workspace.create("next-run.txt", "x")).resolves.toMatchObject({ kind: "created" });
    expect(workspace.changes).toHaveLength(1);
  });

  it("drain awaits in-flight reads as well as writes", async () => {
    await file("notes.txt", "text");
    const completed = vi.fn();
    void workspace.read("notes.txt").then(completed);
    await workspace.drain();
    expect(completed).toHaveBeenCalledOnce();
  });
});
