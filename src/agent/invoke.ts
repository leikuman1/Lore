import { randomUUID } from "node:crypto";
import { isStepCount, type LanguageModel, NoSuchToolError, streamText, type ToolSet } from "ai";
import { z } from "zod";
import { createReferenceTools } from "../tools/reference.js";
import {
  type ErrorCode,
  errorMessages,
  type InvocationEvent,
  type InvocationInput,
  type InvocationResult,
  invocationInputSchema,
  type ToolSummary,
} from "./contracts.js";

const limitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(8),
  timeoutMs: z.number().int().min(1).max(120_000),
});

type InvocationOptions = {
  model?: Exclude<LanguageModel, string>;
  tools?: ToolSet;
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  invocationId?: string;
  now?: () => number;
  onEvent?: (event: InvocationEvent) => void;
};

export async function invokeAgent(
  input: InvocationInput,
  options: InvocationOptions = {},
): Promise<InvocationResult> {
  const { maxSteps, timeoutMs } = limitsSchema.parse({
    maxSteps: options.maxSteps ?? 4,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const now = options.now ?? Date.now;
  const started = now();
  const model = options.model;
  const result: InvocationResult = {
    invocationId: options.invocationId ?? randomUUID(),
    model: model?.modelId ?? "unconfigured",
    output: "",
    finishReason: "completed",
    steps: [],
    events: [],
    usage: null,
  };
  let step = 1;
  const emit = (event: InvocationEvent["event"], status: string, tool: string | null = null) => {
    const record: InvocationEvent = {
      invocationId: result.invocationId,
      event,
      step,
      tool,
      status,
      durationMs: Math.max(0, now() - started),
    };
    result.events.push(record);
    try {
      options.onEvent?.(record);
    } catch {
      // Metadata observers must not interrupt the invocation lifecycle.
    }
  };
  const fail = (code: ErrorCode) => {
    if (result.error) return;
    result.finishReason = code;
    result.error = { code, message: errorMessages[code] };
  };
  emit("started", "running");
  const parsedInput = invocationInputSchema.safeParse(input);
  if (!parsedInput.success) fail("INVALID_REQUEST");
  else if (options.signal?.aborted) fail("ABORTED");
  else if (!model) fail("MODEL_NOT_CONFIGURED");
  if (result.error || !model || !parsedInput.success) {
    emit("finished", result.finishReason);
    return result;
  }

  const controller = new AbortController();
  const cancel = () => {
    fail("ABORTED");
    controller.abort();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    fail("TIMEOUT");
    controller.abort();
  }, timeoutMs);
  const calls = new Map<string, ToolSummary>();
  let completedSteps = 0;
  let lastReason = "";
  try {
    const stream = streamText({
      model,
      prompt: parsedInput.data.message,
      abortSignal: controller.signal,
      onError: () => {},
      tools: options.tools ?? createReferenceTools(),
      stopWhen: [
        isStepCount(maxSteps),
        ({ steps }) =>
          steps
            .at(-1)
            ?.content.some(
              (part) =>
                part.type === "tool-error" || (part.type === "tool-call" && part.invalid === true),
            ) ?? false,
      ],
      maxRetries: 0,
    });
    for await (const part of stream.stream) {
      if (result.error) continue;
      if (part.type === "start-step") result.output = "";
      else if (part.type === "text-delta") result.output += part.text;
      else if (part.type === "tool-call") {
        const summary: ToolSummary = {
          step,
          toolCallId: part.toolCallId,
          tool: part.toolName,
          status: "requested",
        };
        if (!part.invalid) summary.input = part.input;
        result.steps.push(summary);
        calls.set(part.toolCallId, summary);
        emit("tool_requested", "requested", part.toolName);
        if (part.invalid) {
          const code = NoSuchToolError.isInstance(part.error)
            ? "TOOL_NOT_ALLOWED"
            : "TOOL_INPUT_INVALID";
          fail(code);
          summary.status = "failed";
          summary.error = { code, message: errorMessages[code] };
          emit(
            code === "TOOL_INPUT_INVALID" ? "tool_input_invalid" : "tool_failed",
            code,
            part.toolName,
          );
          controller.abort();
        }
      } else if (part.type === "tool-result") {
        const summary = calls.get(part.toolCallId);
        if (summary) {
          summary.status = "succeeded";
          summary.result = part.output;
        }
        emit("tool_completed", "succeeded", part.toolName);
      } else if (part.type === "tool-error") {
        const summary = calls.get(part.toolCallId);
        const code: ErrorCode = "TOOL_ERROR";
        fail(code);
        if (summary) {
          summary.status = "failed";
          summary.error = { code, message: errorMessages[code] };
        }
        emit("tool_failed", code, part.toolName);
        controller.abort();
      } else if (part.type === "finish-step") {
        completedSteps += 1;
        lastReason = part.finishReason;
        emit("model_step_completed", part.finishReason);
        step += 1;
      } else if (part.type === "finish") {
        if (
          part.totalUsage.totalTokens !== undefined ||
          part.totalUsage.inputTokens !== undefined ||
          part.totalUsage.outputTokens !== undefined
        )
          result.usage = part.totalUsage;
      } else if (part.type === "error") {
        fail("MODEL_ERROR");
        controller.abort();
      } else if (part.type === "abort") {
        if (!result.error) fail("ABORTED");
      }
    }
    if (!result.error) {
      if (lastReason === "tool-calls" && completedSteps >= maxSteps) fail("STEP_LIMIT");
      else if (lastReason !== "stop") fail("MODEL_ERROR");
    }
  } catch {
    if (!result.error) fail(options.signal?.aborted ? "ABORTED" : "MODEL_ERROR");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    for (const summary of result.steps) {
      if (summary.status === "requested") {
        summary.status = "failed";
        const code = result.finishReason === "completed" ? "MODEL_ERROR" : result.finishReason;
        summary.error = { code, message: errorMessages[code] };
        emit("tool_failed", code, summary.tool);
      }
    }
    emit("finished", result.finishReason);
  }
  return result;
}
