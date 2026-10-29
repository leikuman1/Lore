import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { createApp } from "../dist/api/app.js";
import { parseEnvironment } from "../dist/config/env.js";

const root = await mkdtemp(join(tmpdir(), "lore-page-smoke-"));
await writeFile(join(root, "notes.txt"), "first\r\n", "utf8");
const app = createApp({
  env: parseEnvironment({ MODEL_PROVIDER: "mock", AGENT_MAX_STEPS: "8" }),
  onEvent: () => {},
  pickDirectory: async () => root,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
async function post(path, body) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `HTTP ${response.status}`);
  return response.json();
}
async function run(sessionId, tool, input) {
  const { runId } = await post("/workspace/invoke", {
    sessionId,
    message: `mock:${JSON.stringify({ tool, input })}`,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await (await fetch(`${base}/workspace/run/${runId}`)).json();
    if (result.status === "finished") {
      assert.equal(result.result.finishReason, "completed");
      return result;
    }
    await delay(20);
  }
  throw new Error("Run failed to finish");
}
async function close() {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
if (process.argv.includes("--browser")) {
  console.info(
    `Mock browser fixture ready at ${base}; native picker replaced only in this smoke harness.`,
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else {
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Lore 工作区/);
    const hostile = await fetch(`${base}/workspace/select`, {
      method: "POST",
      headers: { origin: "https://example.test", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(hostile.status, 403);
    const { session } = await post("/workspace/select", {});
    const read = await run(session.id, "read_file", { path: "notes.txt" });
    const version = read.result.steps[0].result.version;
    const edit = await run(session.id, "edit_file", {
      path: "notes.txt",
      oldText: "first",
      newText: "second",
      version,
    });
    assert.equal(edit.changes[0].after, "second\r\n");
    await run(session.id, "create_file", { path: "result.txt", content: "created" });
    assert.equal(await readFile(join(root, "result.txt"), "utf8"), "created");
    const { session: next } = await post("/workspace/select", {});
    assert.notEqual(next.id, session.id);
    assert.equal(next.messages.length, 0);
    console.info(
      "Phase two HTTP smoke PASS: page, origin, selection, read, edit, create, conversation and workspace switch.",
    );
  } finally {
    await close();
  }
}
