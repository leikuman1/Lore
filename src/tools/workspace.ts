import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { WORKSPACE_LIMITS, type Workspace, WorkspaceError } from "../workspace/workspace.js";

const filePath = z.string().min(1).max(WORKSPACE_LIMITS.pathLength);
const directoryPath = filePath.default(".");
const text = z.string().max(WORKSPACE_LIMITS.fileBytes);

async function result<T>(action: () => Promise<T>, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    return await action();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof WorkspaceError)
      return { error: { code: error.code, message: error.message } };
    const code = (error as NodeJS.ErrnoException)?.code;
    const known: Record<string, string> = {
      ENOENT: "The relative path does not exist.",
      EEXIST: "The file already exists; creation never overwrites.",
      EACCES: "Workspace access was denied.",
      EPERM: "Workspace access was denied.",
      ENOTDIR: "A path component is not a directory.",
      EISDIR: "The target is a directory.",
      ELOOP: "Links and junctions are forbidden.",
    };
    return {
      error: {
        code: code && known[code] ? code : "IO_ERROR",
        message: code && known[code] ? known[code] : "Workspace operation failed.",
      },
    };
  }
}

export function createWorkspaceTools(workspace: Workspace): ToolSet {
  return {
    list_files: tool({
      description:
        "List one workspace directory. Excluded entries and truncation are explicit. Only relative paths are accepted.",
      inputSchema: z.strictObject({ path: directoryPath }),
      execute: ({ path }, { abortSignal }) =>
        result(() => workspace.list(path, abortSignal), abortSignal),
    }),
    read_file: tool({
      description:
        "Read UTF-8 text using zero-based line offset and line limit. A complete read returns a version required by edit_file. Files are limited to 64 KiB; preserve the returned BOM and exact oldText.",
      inputSchema: z.strictObject({
        path: filePath,
        offset: z.number().int().min(0).max(65536).default(0),
        limit: z.number().int().min(1).max(65536).default(65536),
      }),
      execute: ({ path, offset, limit }, { abortSignal }) =>
        result(() => workspace.read(path, offset, limit, abortSignal), abortSignal),
    }),
    search_files: tool({
      description:
        "Bounded literal name or content search under a relative directory. Excluded counts and truncation are explicit; content snippets are partial and do not authorize edits.",
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200),
        mode: z.enum(["name", "content"]),
        path: directoryPath,
      }),
      execute: ({ query, mode, path }, { abortSignal }) =>
        result(() => workspace.search(query, mode, path, abortSignal), abortSignal),
    }),
    create_file: tool({
      description:
        "Exclusively create a UTF-8 file under an existing workspace directory; never overwrite. Successful writes remain recorded after cancellation.",
      inputSchema: z.strictObject({ path: filePath, content: text }),
      execute: ({ path, content }, { abortSignal }) =>
        result(() => workspace.create(path, content, abortSignal), abortSignal),
    }),
    edit_file: tool({
      description:
        "Replace exactly one occurrence of oldText after a complete read_file. Use the returned version; conflicts require rereading. Preserves UTF-8 BOM and existing CRLF convention.",
      inputSchema: z.strictObject({
        path: filePath,
        oldText: text.min(1),
        newText: text,
        version: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      execute: ({ path, oldText, newText, version }, { abortSignal }) =>
        result(() => workspace.edit(path, oldText, newText, version, abortSignal), abortSignal),
    }),
  };
}
