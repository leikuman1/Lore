import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./env.js";

describe("environment configuration", () => {
  it("supports offline startup and empty optional settings", () => {
    const env = parseEnvironment({ DATABASE_URL: "", MODEL_API_KEY: " " });

    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MODEL_API_KEY).toBeUndefined();
  });

  it("enforces loopback and bounded execution settings", () => {
    expect(() => parseEnvironment({ HOST: "0.0.0.0" })).toThrow("HOST");
    expect(() => parseEnvironment({ AGENT_MAX_STEPS: "9" })).toThrow("AGENT_MAX_STEPS");
    expect(() => parseEnvironment({ AGENT_TIMEOUT_MS: "0" })).toThrow("AGENT_TIMEOUT_MS");
    expect(parseEnvironment({}).AGENT_MAX_STEPS).toBe(4);
    expect(parseEnvironment({}).AGENT_TIMEOUT_MS).toBe(30_000);
  });

  it("rejects invalid ports", () => {
    expect(() => parseEnvironment({ PORT: "70000" })).toThrow("PORT");
  });

  it("does not include configuration values in validation errors", () => {
    expect(() => parseEnvironment({ PORT: "sensitive-example-value" })).toThrow(
      "Invalid environment configuration: PORT",
    );
  });
});
