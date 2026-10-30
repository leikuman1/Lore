import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseEnvironment } from "../config/env.js";
import { createApp } from "./app.js";

const sessionSchema = z.object({
  session: z.object({
    id: z.string(),
    messages: z.array(z.unknown()),
    runId: z.string().nullable(),
  }),
});
const runSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "finished"]),
  changes: z.array(
    z.object({ path: z.string(), kind: z.string(), before: z.string(), after: z.string() }),
  ),
  result: z
    .object({
      finishReason: z.string(),
      output: z.string(),
      steps: z.array(
        z.object({
          tool: z.string(),
          status: z.string(),
          result: z.object({ version: z.string().optional() }).passthrough().optional(),
        }),
      ),
    })
    .nullable(),
});
const roots: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lore-api-"));
  roots.push(root);
  await writeFile(join(root, "note.txt"), "original\r\n", "utf8");
  const picker = vi.fn(async () => root);
  const app = createApp({
    env: parseEnvironment({ MODEL_PROVIDER: "mock" }),
    onEvent: vi.fn(),
    pickDirectory: picker,
  });
  apps.push(app);
  return { root, app, picker };
}
function post(value: unknown, origin = "http://localhost") {
  return {
    method: "POST",
    headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(value),
  };
}
async function session(app: ReturnType<typeof createApp>) {
  const response = await app.request("/workspace/select", post({}));
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json()).session.id;
}
async function run(app: ReturnType<typeof createApp>, sessionId: string, message: string) {
  const response = await app.request("/workspace/invoke", post({ sessionId, message }));
  expect(response.status).toBe(202);
  const { runId } = z.object({ runId: z.string() }).parse(await response.json());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = runSchema.parse(await (await app.request(`/workspace/run/${runId}`)).json());
    if (snapshot.status === "finished") return snapshot;
    await delay(5);
  }
  throw new Error("Run did not finish");
}

describe("local workspace HTTP flow", () => {
  it("serves a self-contained page with a fresh CSP nonce and no cache", async () => {
    const { app } = await fixture();
    const response = await app.request("/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("选择");
    expect(html).not.toContain("__LORE_NONCE__");
    expect(html).not.toContain("MODEL_API_KEY");
    expect((await app.request("/")).headers.get("content-security-policy")).not.toBe(
      response.headers.get("content-security-policy"),
    );
  });

  it.each([undefined, "https://attacker.example", "http://127.0.0.1"])(
    "rejects mutation from mismatching or missing origin %s before opening picker",
    async (origin) => {
      const { app, picker } = await fixture();
      const request = post({});
      if (origin) request.headers.origin = origin;
      else Reflect.deleteProperty(request.headers, "origin");
      expect((await app.request("/workspace/select", request)).status).toBe(403);
      expect(picker).not.toHaveBeenCalled();
    },
  );

  it("selects a directory, uses real file tools, keeps conversation and displays changes", async () => {
    const { root, app } = await fixture();
    const id = await session(app);
    const list = await run(app, id, "列出工作区");
    expect(list.result?.finishReason).toBe("completed");
    expect(list.result?.steps[0]?.tool).toBe("list_files");
    expect(list.result?.output).toContain("note.txt");
    const created = await run(
      app,
      id,
      'mock:{"tool":"create_file","input":{"path":"new.txt","content":"created"}}',
    );
    expect(created.result?.finishReason).toBe("completed");
    expect(created.changes).toEqual([
      expect.objectContaining({ path: "new.txt", kind: "created", before: "", after: "created" }),
    ]);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created");
    const read = await run(app, id, 'mock:{"tool":"read_file","input":{"path":"note.txt"}}');
    const version = z.string().parse(read.result?.steps[0]?.result?.version);
    const edited = await run(
      app,
      id,
      `mock:${JSON.stringify({ tool: "edit_file", input: { path: "note.txt", oldText: "original", newText: "changed", version } })}`,
    );
    expect(edited.changes[0]).toMatchObject({
      kind: "modified",
      before: "original\r\n",
      after: "changed\r\n",
    });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("changed\r\n");
    const snapshot = sessionSchema.parse(await (await app.request("/workspace/session")).json());
    expect(snapshot.session.messages).toHaveLength(8);
    expect(snapshot.session.runId).toBe(edited.id);
    const reset = await app.request("/workspace/reset", post({}));
    expect(await reset.json()).toEqual({ session: null });
    expect(
      (await app.request("/workspace/invoke", post({ sessionId: id, message: "old" }))).status,
    ).toBe(404);
  });

  it("shows recoverable file errors as failed tools without claiming a write succeeded", async () => {
    const { app, root } = await fixture();
    const id = await session(app);
    const rejected = await run(
      app,
      id,
      'mock:{"tool":"create_file","input":{"path":"note.txt","content":"overwritten"}}',
    );
    expect(rejected.result?.steps[0]?.status).toBe("failed");
    expect(rejected.changes).toEqual([]);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("original\r\n");
  });

  it("rejects stale sessions and malformed requests without invoking tools", async () => {
    const { app } = await fixture();
    const id = await session(app);
    await session(app);
    expect(
      (await app.request("/workspace/invoke", post({ sessionId: id, message: "stale" }))).status,
    ).toBe(404);
    expect((await app.request("/workspace/select", post({ path: "C:\\" }))).status).toBe(400);
    expect(
      (await app.request("/workspace/invoke", post({ message: "missing session" }))).status,
    ).toBe(400);
    expect((await app.request("/workspace/run/missing")).status).toBe(404);
  });
});
