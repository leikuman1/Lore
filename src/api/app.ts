import { Hono } from "hono";
import {
  type ErrorCode,
  errorMessages,
  type InvocationEvent,
  invocationInputSchema,
} from "../agent/contracts.js";
import { invokeAgent } from "../agent/invoke.js";
import { type Environment, parseEnvironment } from "../config/env.js";
import { resolveModel } from "../models/resolve.js";

const errorStatuses = {
  INVALID_REQUEST: 400,
  MODEL_NOT_CONFIGURED: 503,
  MODEL_ERROR: 502,
  TOOL_INPUT_INVALID: 422,
  TOOL_NOT_ALLOWED: 422,
  TOOL_ERROR: 502,
  STEP_LIMIT: 422,
  TIMEOUT: 504,
  ABORTED: 408,
} as const satisfies Record<ErrorCode, number>;

async function readBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" || !request.body) throw new Error("Invalid body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createApp(
  options: { env?: Environment; onEvent?: (event: InvocationEvent) => void } = {},
) {
  const env = options.env ?? parseEnvironment({});
  const model = resolveModel(env);
  const onEvent =
    options.onEvent ?? ((event: InvocationEvent) => console.info(JSON.stringify(event)));
  const app = new Hono();

  app.get("/health", (context) =>
    context.json({ service: "lore", status: "ok", stage: "phase-01" }),
  );

  app.post("/agent/invoke", async (context) => {
    let body: unknown;
    try {
      body = await readBody(context.req.raw);
    } catch {
      return context.json(
        { error: { code: "INVALID_REQUEST", message: errorMessages.INVALID_REQUEST } },
        400,
      );
    }
    const input = invocationInputSchema.safeParse(body);
    if (!input.success) {
      return context.json(
        { error: { code: "INVALID_REQUEST", message: errorMessages.INVALID_REQUEST } },
        400,
      );
    }
    const result = await invokeAgent(input.data, {
      ...(model ? { model } : {}),
      maxSteps: env.AGENT_MAX_STEPS,
      timeoutMs: env.AGENT_TIMEOUT_MS,
      signal: context.req.raw.signal,
      onEvent,
    });
    return context.json(result, result.error ? errorStatuses[result.error.code] : 200);
  });

  return app;
}
