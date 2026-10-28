import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Environment } from "../config/env.js";
import { createMockModel } from "./mock.js";

export function resolveModel(env: Environment): Exclude<LanguageModel, string> | undefined {
  if (env.MODEL_PROVIDER === "mock") {
    if (env.NODE_ENV === "production") throw new Error("Mock is disabled in production.");
    return createMockModel();
  }
  if (env.MODEL_PROVIDER === "magpie") {
    if (!env.MODEL_ID) throw new Error("Magpie requires MODEL_ID.");
    const provider = createOpenAI({
      name: "magpie",
      baseURL: env.MODEL_BASE_URL ?? "http://127.0.0.1:3425/v1",
      apiKey: env.MODEL_API_KEY ?? "magpie",
    });
    return env.MODEL_API === "responses"
      ? provider.responses(env.MODEL_ID)
      : provider.chat(env.MODEL_ID);
  }
  return undefined;
}
