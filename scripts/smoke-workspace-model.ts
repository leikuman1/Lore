import "dotenv/config";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApp } from "../src/api/app.js";
import { parseEnvironment } from "../src/config/env.js";

async function main() {
  if (process.env.RUN_MODEL_SMOKE !== "1")
    throw new Error("Set RUN_MODEL_SMOKE=1 to enable real workspace model calls.");
  const env = parseEnvironment({
    ...process.env,
    AGENT_MAX_STEPS: "8",
    AGENT_TIMEOUT_MS: "120000",
  });
  if (env.MODEL_PROVIDER !== "magpie") throw new Error("Configure MODEL_PROVIDER=magpie first.");
  const root = await mkdtemp(join(tmpdir(), "lore-model-workspace-"));
  await writeFile(join(root, "alpha.txt"), "Project: Lantern\n", "utf8");
  await writeFile(join(root, "beta.txt"), "Status: planned\n", "utf8");
  const app = createApp({ env, onEvent: () => {}, pickDirectory: async () => root });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server did not bind.");
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, `HTTP ${response.status}`);
    return response.json();
  };
  const resultSchema = z.object({
    status: z.enum(["running", "finished"]),
    result: z
      .object({
        model: z.string(),
        finishReason: z.string(),
        output: z.string(),
        steps: z.array(z.object({ tool: z.string(), status: z.string() })),
        usage: z.unknown(),
      })
      .nullable(),
    changes: z.array(z.object({ path: z.string(), kind: z.string() })),
  });
  try {
    const selected = z
      .object({ session: z.object({ id: z.string() }) })
      .parse(await post("/workspace/select", {}));
    const run = async (message: string) => {
      const { runId } = z
        .object({ runId: z.string() })
        .parse(await post("/workspace/invoke", { sessionId: selected.session.id, message }));
      for (let attempt = 0; attempt < 650; attempt++) {
        const state = resultSchema.parse(
          await (await fetch(`${base}/workspace/run/${runId}`)).json(),
        );
        if (state.status === "finished") {
          assert.equal(
            state.result?.finishReason,
            "completed",
            `Workspace model run failed: ${state.result?.finishReason}`,
          );
          assert.ok(state.result?.output.trim());
          return state;
        }
        await delay(200);
      }
      throw new Error("Workspace model run did not finish.");
    };
    const first = await run(
      'Read alpha.txt and beta.txt using read_file. Create summary.txt containing exactly "Lantern: planned\\n" (the final \\n means a newline). Then edit beta.txt from "Status: planned" to "Status: ready" using its read version. Do not change alpha.txt. Finish with a brief summary.',
    );
    assert.equal(await readFile(join(root, "summary.txt"), "utf8"), "Lantern: planned\n");
    assert.equal(await readFile(join(root, "beta.txt"), "utf8"), "Status: ready\n");
    assert.ok(
      first.changes.some((change) => change.path === "summary.txt" && change.kind === "created"),
    );
    assert.ok(
      first.changes.some((change) => change.path === "beta.txt" && change.kind === "modified"),
    );
    const followup = await run(
      'Continue the previous task: reread the summary file you created and beta.txt. Update only the summary file so it contains exactly "Lantern: ready\\n". Use edit_file with the version from read_file.',
    );
    assert.equal(await readFile(join(root, "summary.txt"), "utf8"), "Lantern: ready\n");
    assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "Project: Lantern\n");
    console.info(
      JSON.stringify({
        status: "passed",
        model: first.result?.model,
        runs: [first, followup].map((entry) => ({
          finishReason: entry.result?.finishReason,
          toolCalls: entry.result?.steps.length,
          changes: entry.changes,
          usage: entry.result?.usage,
        })),
      }),
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Workspace model smoke failed.");
  process.exitCode = 1;
});
