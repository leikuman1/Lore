import { z } from "zod";
import { isLoopbackHostname } from "./loopback.js";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.literal("127.0.0.1").default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: optionalText,
    MODEL_PROVIDER: optionalText,
    MODEL_ID: optionalText,
    MODEL_API_KEY: optionalText,
    MODEL_BASE_URL: optionalText,
    MODEL_API: z.enum(["chat", "responses"]).default("chat"),
    AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(8).default(4),
    AGENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(30_000),
  })
  .superRefine((env, context) => {
    if (env.MODEL_PROVIDER === "magpie") {
      if (!env.MODEL_ID) {
        context.addIssue({
          code: "custom",
          path: ["MODEL_ID"],
          message: "Magpie requires a model ID.",
        });
      }
      if (env.MODEL_BASE_URL) {
        const url = URL.canParse(env.MODEL_BASE_URL) ? new URL(env.MODEL_BASE_URL) : undefined;
        if (
          !url ||
          !["http:", "https:"].includes(url.protocol) ||
          (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          context.addIssue({
            code: "custom",
            path: ["MODEL_BASE_URL"],
            message:
              "Expected HTTPS (HTTP allowed only for loopback), without credentials, query or fragment.",
          });
        }
      }
    }
    if (env.NODE_ENV === "production" && env.MODEL_PROVIDER === "mock") {
      context.addIssue({
        code: "custom",
        path: ["MODEL_PROVIDER"],
        message: "Mock is disabled in production.",
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${fields.join(", ")}`);
  }
  return result.data;
}
