import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Workspace } from "../workspace/workspace.js";
import { createWorkspaceTools } from "./workspace.js";

let root: string;
let workspace: Workspace;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lore-tools-"));
  workspace = await Workspace.open(root);
});
afterEach(async () => {
  await workspace.drain();
  await rm(root, { recursive: true, force: true });
});

function execute(name: string, input: unknown, abortSignal?: AbortSignal) {
  const selected = createWorkspaceTools(workspace)[name];
  if (!selected?.execute) throw new Error("Missing workspace tool");
  const run = selected.execute as unknown as (
    input: unknown,
    options: { toolCallId: string; messages: []; abortSignal?: AbortSignal },
  ) => Promise<unknown>;
  return run(input, {
    toolCallId: "test-call",
    messages: [],
    ...(abortSignal ? { abortSignal } : {}),
  });
}

it("routes every tool through the workspace and returns recoverable errors", async () => {
  expect(Object.keys(createWorkspaceTools(workspace))).toEqual([
    "list_files",
    "read_file",
    "search_files",
    "create_file",
    "edit_file",
  ]);
  await expect(
    execute("create_file", { path: "notes.txt", content: "before" }),
  ).resolves.toMatchObject({ path: "notes.txt", kind: "created" });
  await expect(
    execute("create_file", { path: "notes.txt", content: "overwritten" }),
  ).resolves.toEqual({
    error: { code: "EEXIST", message: "The file already exists; creation never overwrites." },
  });
  const read = (await execute("read_file", { path: "notes.txt", offset: 0, limit: 65536 })) as {
    version: string;
  };
  await expect(
    execute("edit_file", {
      path: "notes.txt",
      oldText: "before",
      newText: "after",
      version: read.version,
    }),
  ).resolves.toMatchObject({ kind: "modified" });
  await expect(
    execute("search_files", { query: "after", mode: "content", path: "." }),
  ).resolves.toMatchObject({ matches: [{ path: "notes.txt", line: 1, text: "after" }] });
  await expect(execute("list_files", { path: "." })).resolves.toMatchObject({
    entries: [{ path: "notes.txt", kind: "file" }],
  });
  expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("after");
});

it("does not expose absolute filesystem paths in errors", async () => {
  await expect(execute("read_file", { path: "missing.txt", offset: 0, limit: 1 })).resolves.toEqual(
    { error: { code: "ENOENT", message: "The relative path does not exist." } },
  );
  const escaped = await execute("read_file", { path: "../outside", offset: 0, limit: 1 });
  expect(escaped).toMatchObject({ error: { code: "INVALID_PATH" } });
  expect(JSON.stringify(escaped)).not.toContain(root);
});

it("throws cancellation rather than converting it into a recoverable model result", async () => {
  await expect(
    execute("create_file", { path: "cancelled.txt", content: "x" }, AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(workspace.changes).toEqual([]);
});
