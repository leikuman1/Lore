import type { LanguageModel } from "ai";

type Model = Extract<LanguageModel, { specificationVersion: "v4" }>;
type CallOptions = Parameters<Model["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<Model["doGenerate"]>>;
type StreamPart =
  Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

export function createMockModel(options: { repeatTools?: boolean } = {}): Model {
  const generate = (call: CallOptions): GenerateResult => {
    call.abortSignal?.throwIfAborted();
    const message = call.prompt.findLast((entry) => entry.role === "user");
    const text = message?.content.find((part) => part.type === "text")?.text ?? "lore";
    const current = call.prompt.slice(
      call.prompt.findLastIndex((entry) => entry.role === "user") + 1,
    );
    const previous = current
      .filter((entry) => entry.role === "tool")
      .flatMap((entry) => entry.content)
      .filter((part) => part.type === "tool-result");
    const workspace = call.tools?.some((entry) => entry.name === "list_files") ?? false;
    const plainText = text.startsWith("text:");
    let toolName = "lookup_reference";
    let input: unknown = { key: text };
    let commandError = "";
    if (workspace) {
      toolName = "list_files";
      input = { path: "." };
      if (text.startsWith("mock:")) {
        try {
          const parsed: unknown = JSON.parse(text.slice(5));
          if (!parsed || typeof parsed !== "object" || !("tool" in parsed) || !("input" in parsed))
            throw new Error("Invalid mock command");
          const command = parsed as { tool: unknown; input: unknown };
          if (typeof command.tool !== "string") throw new Error("Invalid mock tool");
          toolName = command.tool;
          input = command.input;
        } catch {
          commandError = 'mock 命令格式：mock:{"tool":"list_files","input":{"path":"."}}';
        }
      }
    }
    const useTool = !plainText && !commandError && (options.repeatTools || previous.length === 0);
    return {
      content: useTool
        ? [
            {
              type: "tool-call",
              toolCallId: `mock-call-${previous.length + 1}`,
              toolName,
              input: JSON.stringify(input),
            },
          ]
        : [
            {
              type: "text",
              text:
                commandError ||
                (plainText
                  ? `[mock] ${text.slice(5)}`
                  : `[mock${workspace ? " 工作区演示" : ""}] ${JSON.stringify(previous.at(-1)?.output)}`),
            },
          ],
      finishReason: { unified: useTool ? "tool-calls" : "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      warnings: [],
    };
  };
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock:reference-v1",
    supportedUrls: {},
    doGenerate: async (call) => generate(call),
    doStream: async (call) => {
      const result = generate(call);
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const content of result.content) {
              if (content.type === "tool-call") controller.enqueue(content);
              else if (content.type === "text") {
                controller.enqueue({ type: "text-start", id: "mock-text" });
                controller.enqueue({ type: "text-delta", id: "mock-text", delta: content.text });
                controller.enqueue({ type: "text-end", id: "mock-text" });
              }
            }
            controller.enqueue({
              type: "finish",
              finishReason: result.finishReason,
              usage: result.usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}
