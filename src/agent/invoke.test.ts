import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel } from "../models/mock.js";
import { createReferenceTools } from "../tools/reference.js";
import { invokeAgent } from "./invoke.js";

const fixed = { invocationId: "invocation-test", now: () => 100 };

afterEach(() => vi.useRealTimers());

describe("bounded agent invocation", () => {
  it("fills the tool result back into the model and emits ordered metadata", async () => {
    const execute = vi.fn(async ({ key }: { key: string }) => ({ found: true, value: key }));
    const tools = {
      lookup_reference: tool({ inputSchema: z.object({ key: z.string() }), execute }),
    };
    const onEvent = vi.fn();
    const result = await invokeAgent(
      { message: "lore" },
      { ...fixed, model: createMockModel(), tools, onEvent },
    );
    expect(result.finishReason).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("lore");
    expect(result.steps).toEqual([
      expect.objectContaining({
        input: { key: "lore" },
        status: "succeeded",
        result: { found: true, value: "lore" },
      }),
    ]);
    expect(result.events.map((event) => event.event)).toEqual([
      "started",
      "tool_requested",
      "tool_completed",
      "model_step_completed",
      "model_step_completed",
      "finished",
    ]);
    expect(onEvent).toHaveBeenCalledTimes(result.events.length);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('"key"');
    expect(result.usage).toBeNull();
  });

  it("supports a plain text completion without tools", async () => {
    const result = await invokeAgent(
      { message: "text:hello" },
      { ...fixed, model: createMockModel() },
    );
    expect(result.finishReason).toBe("completed");
    expect(result.output).toContain("hello");
    expect(result.steps).toEqual([]);
  });

  it("returns found:false for unknown reference keys", async () => {
    const result = await invokeAgent(
      { message: "missing-key" },
      { ...fixed, model: createMockModel() },
    );
    expect(result.finishReason).toBe("completed");
    expect(result.steps[0]?.result).toEqual({ found: false });
  });

  it("does not execute invalid tool parameters or expose raw input", async () => {
    const execute = vi.fn();
    const result = await invokeAgent(
      { message: "lore" },
      {
        ...fixed,
        model: createMockModel(),
        tools: {
          lookup_reference: tool({ inputSchema: z.object({ different: z.number() }), execute }),
        },
      },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe("TOOL_INPUT_INVALID");
    expect(result.steps[0]?.input).toBeUndefined();
    expect(result.events.some((event) => event.event === "tool_input_invalid")).toBe(true);
  });

  it("rejects unregistered tools", async () => {
    const result = await invokeAgent(
      { message: "lore" },
      { ...fixed, model: createMockModel(), tools: {} },
    );
    expect(result.finishReason).toBe("TOOL_NOT_ALLOWED");
  });

  it("stops on tool failure, sanitizes errors, and keeps completed steps", async () => {
    let calls = 0;
    const result = await invokeAgent(
      { message: "lore" },
      {
        ...fixed,
        model: createMockModel({ repeatTools: true }),
        tools: {
          lookup_reference: tool({
            inputSchema: z.object({ key: z.string() }),
            execute: async () => {
              calls += 1;
              if (calls === 2) throw new Error("secret-provider-stack");
              return { found: true };
            },
          }),
        },
      },
    );
    expect(calls).toBe(2);
    expect(result.finishReason).toBe("TOOL_ERROR");
    expect(result.steps.map((step) => step.status)).toEqual(["succeeded", "failed"]);
    expect(JSON.stringify(result)).not.toContain("secret-provider-stack");
  });

  it("stops repeated tool calls at the server step limit", async () => {
    const result = await invokeAgent(
      { message: "lore" },
      { ...fixed, model: createMockModel({ repeatTools: true }), maxSteps: 2 },
    );
    expect(result.finishReason).toBe("STEP_LIMIT");
    expect(result.steps).toHaveLength(2);
  });

  it("rejects invalid limits and invalid executor input", async () => {
    const options = { ...fixed, model: createMockModel() };
    await expect(invokeAgent({ message: "lore" }, { ...options, maxSteps: 9 })).rejects.toThrow();
    expect((await invokeAgent({ message: " " }, options)).finishReason).toBe("INVALID_REQUEST");
  });

  it("handles pre-cancelled requests without calling the model", async () => {
    const result = await invokeAgent(
      { message: "lore" },
      { ...fixed, model: createMockModel(), signal: AbortSignal.abort() },
    );
    expect(result.finishReason).toBe("ABORTED");
    expect(result.steps).toEqual([]);
  });

  it.each(["timeout", "abort"])("propagates %s to a running tool and settles it", async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    let settled = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const promise = invokeAgent(
      { message: "lore" },
      {
        ...fixed,
        model: createMockModel(),
        timeoutMs: 100,
        signal: controller.signal,
        tools: {
          lookup_reference: tool({
            inputSchema: z.object({ key: z.string() }),
            execute: async (_input, { abortSignal }) => {
              toolSignal = abortSignal;
              started();
              await new Promise<void>((_resolve, reject) => {
                abortSignal?.addEventListener(
                  "abort",
                  () => {
                    settled = true;
                    reject(abortSignal.reason);
                  },
                  { once: true },
                );
              });
              return { found: false };
            },
          }),
        },
      },
    );
    await ready;
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(100);
    else controller.abort();
    const result = await promise;
    expect(result.finishReason).toBe(mode === "timeout" ? "TIMEOUT" : "ABORTED");
    expect(toolSignal?.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it("sanitizes model failures and makes no retries", async () => {
    const failure = vi.fn(() => {
      throw new Error("secret-model-response");
    });
    const model = new MockLanguageModelV4({ doStream: failure });
    const result = await invokeAgent({ message: "lore" }, { ...fixed, model });
    expect(result.finishReason).toBe("MODEL_ERROR");
    expect(JSON.stringify(result)).not.toContain("secret-model-response");
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "abort"])("propagates %s while awaiting a model response", async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let modelSignal: AbortSignal | undefined;
    let settled = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        modelSignal = abortSignal;
        started();
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              settled = true;
              reject(abortSignal.reason);
            },
            { once: true },
          );
        });
        return {
          stream: new ReadableStream({
            start(stream) {
              stream.close();
            },
          }),
        };
      },
    });
    const promise = invokeAgent(
      { message: "lore" },
      { ...fixed, model, timeoutMs: 100, signal: controller.signal },
    );
    await ready;
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(100);
    else controller.abort();
    const result = await promise;
    expect(result.finishReason).toBe(mode === "timeout" ? "TIMEOUT" : "ABORTED");
    expect(modelSignal?.aborted).toBe(true);
    expect(settled).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("returns SDK usage without estimates", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({ type: "text-delta", id: "text", delta: "done" });
            controller.enqueue({ type: "text-end", id: "text" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      },
    });
    const result = await invokeAgent({ message: "lore" }, { ...fixed, model });
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it("only exposes the fixed reference tool in the runtime registry", () => {
    expect(Object.keys(createReferenceTools())).toEqual(["lookup_reference"]);
  });
});
