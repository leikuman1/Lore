import "dotenv/config";
import assert from "node:assert/strict";
import { invokeAgent } from "../src/agent/invoke.js";
import { parseEnvironment } from "../src/config/env.js";
import { resolveModel } from "../src/models/resolve.js";

async function main() {
  if (process.env.RUN_MODEL_SMOKE !== "1") {
    throw new Error(
      "Set RUN_MODEL_SMOKE=1 to explicitly enable a real model call (may incur usage charges).",
    );
  }
  const env = parseEnvironment(process.env);
  if (env.MODEL_PROVIDER !== "magpie") throw new Error("Configure MODEL_PROVIDER=magpie first.");
  const model = resolveModel(env);
  if (!model) throw new Error("No model configured.");
  const result = await invokeAgent(
    {
      message:
        "Use lookup_reference with key lore exactly once, then briefly summarize its returned value.",
    },
    { model, maxSteps: env.AGENT_MAX_STEPS, timeoutMs: env.AGENT_TIMEOUT_MS },
  );
  assert.equal(result.finishReason, "completed", `Model smoke failed: ${result.finishReason}`);
  assert.equal(result.steps.length, 1, "Expected exactly one tool call.");
  assert.equal(result.steps[0]?.tool, "lookup_reference");
  assert.equal(result.steps[0]?.status, "succeeded");
  assert.deepEqual(result.steps[0]?.input, { key: "lore" });
  assert.ok(result.output.trim(), "Expected a final text response.");
  console.info(
    JSON.stringify({
      status: "passed",
      model: result.model,
      finishReason: result.finishReason,
      toolCalls: result.steps.length,
      usage: result.usage,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Model smoke failed.");
  process.exitCode = 1;
});
