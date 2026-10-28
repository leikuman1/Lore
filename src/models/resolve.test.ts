import { describe, expect, it, vi } from "vitest";
import { invokeAgent } from "../agent/invoke.js";
import { parseEnvironment } from "../config/env.js";
import { resolveModel } from "./resolve.js";

describe("model configuration", () => {
  it("does not default to a gateway or a real model", () => {
    expect(resolveModel(parseEnvironment({}))).toBeUndefined();
    expect(
      resolveModel(parseEnvironment({ MODEL_PROVIDER: "unknown", MODEL_ID: "secret" })),
    ).toBeUndefined();
  });

  it("labels the offline model explicitly", () => {
    expect(resolveModel(parseEnvironment({ MODEL_PROVIDER: "mock" }))?.modelId).toBe(
      "mock:reference-v1",
    );
  });

  it.each(["chat", "responses"])("constructs Magpie %s models without making a request", (api) => {
    const model = resolveModel(
      parseEnvironment({
        MODEL_PROVIDER: "magpie",
        MODEL_ID: "fixture/model",
        MODEL_API: api,
        NODE_ENV: "production",
      }),
    );
    expect(model?.modelId).toBe("fixture/model");
    expect(model?.provider).toContain("magpie");
  });

  it("validates required Magpie settings without leaking their values", () => {
    expect(() => parseEnvironment({ MODEL_PROVIDER: "magpie" })).toThrow("MODEL_ID");
    for (const url of [
      "not-a-url",
      "file:///tmp/model",
      "https://user:secret@example.test/v1",
      "http://localhost/v1?key=secret",
    ]) {
      expect(() =>
        parseEnvironment({ MODEL_PROVIDER: "magpie", MODEL_ID: "fixture", MODEL_BASE_URL: url }),
      ).toThrow("Invalid environment configuration: MODEL_BASE_URL");
    }
    expect(() => parseEnvironment({ MODEL_API: "invalid" })).toThrow("MODEL_API");
  });

  it("round-trips Magpie chat tool calls through an offline HTTP fixture", async () => {
    const requests: { url: string; body: Record<string, unknown>; authorization: string | null }[] =
      [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(url),
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const first = requests.length === 1;
      const delta = first
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-reference",
                type: "function",
                function: { name: "lookup_reference", arguments: '{"key":"lore"}' },
              },
            ],
          }
        : { content: "Lore fixture result." };
      const chunk = {
        id: `fixture-${requests.length}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture/model",
        choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const model = resolveModel(
      parseEnvironment({
        MODEL_PROVIDER: "magpie",
        MODEL_ID: "fixture/model",
        MODEL_BASE_URL: "http://127.0.0.1:3425/v1",
        MODEL_API_KEY: "fixture-secret",
      }),
    );
    if (!model) throw new Error("Missing fixture model");
    const result = await invokeAgent(
      { message: "Look up lore." },
      { model, invocationId: "magpie-fixture" },
    );
    expect(result.finishReason).toBe("completed");
    expect(result.steps[0]?.status).toBe("succeeded");
    expect(result.output).toBe("Lore fixture result.");
    expect(result.usage?.totalTokens).toBe(24);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3425/v1/chat/completions",
      authorization: "Bearer fixture-secret",
      body: { model: "fixture/model", stream: true },
    });
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("tool_call_id");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("routes Responses models to the configured gateway", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ error: { message: "secret-provider-error", type: "server_error" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const model = resolveModel(
      parseEnvironment({
        MODEL_PROVIDER: "magpie",
        MODEL_API: "responses",
        MODEL_ID: "codex/fixture",
      }),
    );
    if (!model) throw new Error("Missing fixture model");
    const result = await invokeAgent({ message: "hello" }, { model });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3425/v1/responses");
    expect(result.finishReason).toBe("MODEL_ERROR");
    expect(JSON.stringify(result)).not.toContain("secret-provider-error");
  });

  it("rejects mock at production startup", () => {
    expect(() => parseEnvironment({ NODE_ENV: "production", MODEL_PROVIDER: "mock" })).toThrow(
      "MODEL_PROVIDER",
    );
  });
});
