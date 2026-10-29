import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseEnvironment } from "../config/env.js";
import { createApp } from "./app.js";

const responseSchema = z.object({
  model: z.string(),
  finishReason: z.string(),
  output: z.string(),
  steps: z.array(z.object({ status: z.string() })),
  error: z.object({ code: z.string() }).optional(),
});

function mockApp() {
  return createApp({ env: parseEnvironment({ MODEL_PROVIDER: "mock" }), onEvent: vi.fn() });
}

function post(body: string, contentType = "application/json") {
  return { method: "POST", headers: { "content-type": contentType }, body };
}

describe("agent HTTP API", () => {
  it("starts without database or model credentials", async () => {
    const response = await createApp().request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "lore", status: "ok", stage: "phase-01" });
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("allows loopback host %s", async (host) => {
    expect((await mockApp().request(`http://${host}/health`)).status).toBe(200);
  });

  it.each(["attacker.example", "localhost.attacker.example", "127.0.0.1.attacker.example"])(
    "rejects non-loopback host %s before execution",
    async (host) => {
      const onEvent = vi.fn();
      const app = createApp({ env: parseEnvironment({ MODEL_PROVIDER: "mock" }), onEvent });
      const response = await app.request(`http://${host}/agent/invoke`, post('{"message":"lore"}'));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: "HOST_NOT_ALLOWED", message: expect.any(String) },
      });
      expect(onEvent).not.toHaveBeenCalled();
    },
  );

  it("returns a structured mock invocation", async () => {
    const response = await mockApp().request(
      "/agent/invoke",
      post(JSON.stringify({ message: "lore" })),
    );
    expect(response.status).toBe(200);
    const body = responseSchema.parse(await response.json());
    expect(body.model).toBe("mock:reference-v1");
    expect(body.finishReason).toBe("completed");
    expect(body.output).toContain("Lore");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]?.status).toBe("succeeded");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([
    ["", "application/json"],
    ["{", "application/json"],
    ['{"message":"lore"}', "text/plain"],
    ['{"message":"  "}', "application/json"],
    [JSON.stringify({ message: "a".repeat(8_001) }), "application/json"],
    [JSON.stringify({ message: `${" ".repeat(8_000)}a` }), "application/json"],
    [JSON.stringify({ message: 123 }), "application/json"],
    [JSON.stringify({}), "application/json"],
    [JSON.stringify({ message: "lore", maxSteps: 100 }), "application/json"],
    [JSON.stringify({ message: "a".repeat(33_000) }), "application/json"],
    [JSON.stringify({ message: "中".repeat(11_000) }), "application/json"],
  ])("rejects invalid input with 400", async (body, type) => {
    const response = await mockApp().request("/agent/invoke", post(body, type));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: expect.any(String) },
    });
  });

  it("enforces the byte limit on chunked bodies without content-length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16_000).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/agent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await mockApp().request(request);
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });

  it("maps step limits to an explicit HTTP failure with completed tool results", async () => {
    const app = createApp({
      env: parseEnvironment({ MODEL_PROVIDER: "mock", AGENT_MAX_STEPS: "1" }),
      onEvent: vi.fn(),
    });
    const response = await app.request("/agent/invoke", post('{"message":"lore"}'));
    expect(response.status).toBe(422);
    const body = responseSchema.parse(await response.json());
    expect(body.error?.code).toBe("STEP_LIMIT");
    expect(body.steps[0]?.status).toBe("succeeded");
  });

  it("reports missing models without exposing configuration", async () => {
    const response = await createApp({ onEvent: vi.fn() }).request(
      "/agent/invoke",
      post('{"message":"lore"}'),
    );
    expect(response.status).toBe(503);
    const body = responseSchema.parse(await response.json());
    expect(body.error?.code).toBe("MODEL_NOT_CONFIGURED");
    expect(body.steps).toEqual([]);
  });
});
