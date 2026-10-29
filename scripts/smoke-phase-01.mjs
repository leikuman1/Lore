import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 13001;
const env = {
  ...process.env,
  NODE_ENV: "development",
  MODEL_PROVIDER: "mock",
  HOST: "127.0.0.1",
  PORT: String(port),
};
const logs = [];
const server = spawn(process.execPath, ["scripts/with-ca.mjs", "dist/api/index.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
server.stdout.on("data", (chunk) => logs.push(chunk.toString()));
server.stderr.on("data", (chunk) => logs.push(chunk.toString()));

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error("Mock server exited before startup.");
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).stage, "phase-01");
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, "Mock server failed to become ready.");
  const response = await fetch(`http://127.0.0.1:${port}/agent/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "lore" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "mock:reference-v1");
  assert.equal(body.finishReason, "completed");
  assert.equal(body.steps.length, 1);
  assert.equal(body.steps[0].status, "succeeded");
  assert.equal(body.usage, null);
  const events = logs
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.ok(
    events.some((event) => event.event === "finished" && event.invocationId === body.invocationId),
  );
  assert.ok(
    events.every((event) => !Object.hasOwn(event, "input") && !Object.hasOwn(event, "result")),
  );
  console.info("Built mock service: health, tool round-trip and metadata logs PASS.");
} finally {
  if (process.platform === "win32" && server.pid) {
    spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
  } else if (server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error("Failed to stop the smoke process group.");
        process.exitCode = 1;
        server.kill();
      }
    }
  }
  await new Promise((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once("exit", resolve);
  });
}

const production = spawn(process.execPath, ["scripts/with-ca.mjs", "dist/api/index.js"], {
  env: { ...env, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
production.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
const exitCode = await new Promise((resolve) => production.once("exit", resolve));
assert.notEqual(exitCode, 0);
assert.match(output, /MODEL_PROVIDER/);
console.info("Built production service: mock startup rejected PASS.");
