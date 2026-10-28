import type { LanguageModelUsage } from "ai";
import { z } from "zod";

export const invocationInputSchema = z.strictObject({
  message: z.string().max(8_000).trim().min(1),
});

export type InvocationInput = z.infer<typeof invocationInputSchema>;
export type ErrorCode =
  | "INVALID_REQUEST"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_ERROR"
  | "TOOL_INPUT_INVALID"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_ERROR"
  | "STEP_LIMIT"
  | "TIMEOUT"
  | "ABORTED";

export const errorMessages: Record<ErrorCode, string> = {
  INVALID_REQUEST:
    "Expected JSON with a non-empty message of at most 8000 characters (body limit: 32 KiB).",
  MODEL_NOT_CONFIGURED: "No supported model is configured.",
  MODEL_ERROR: "The model call failed or returned an unsupported response.",
  TOOL_INPUT_INVALID: "Tool input failed validation.",
  TOOL_NOT_ALLOWED: "The requested tool is not registered.",
  TOOL_ERROR: "Tool execution failed.",
  STEP_LIMIT: "The maximum number of model steps was reached.",
  TIMEOUT: "The invocation exceeded its time limit.",
  ABORTED: "The invocation was cancelled.",
};

export type ToolSummary = {
  step: number;
  toolCallId: string;
  tool: string;
  status: "requested" | "succeeded" | "failed";
  input?: unknown;
  result?: unknown;
  error?: { code: ErrorCode; message: string };
};

export type InvocationEvent = {
  invocationId: string;
  event:
    | "started"
    | "model_step_completed"
    | "tool_requested"
    | "tool_input_invalid"
    | "tool_completed"
    | "tool_failed"
    | "finished";
  step: number;
  tool: string | null;
  status: string;
  durationMs: number;
};

export type InvocationResult = {
  invocationId: string;
  model: string;
  output: string;
  finishReason: "completed" | ErrorCode;
  steps: ToolSummary[];
  events: InvocationEvent[];
  usage: LanguageModelUsage | null;
  error?: { code: ErrorCode; message: string };
};
