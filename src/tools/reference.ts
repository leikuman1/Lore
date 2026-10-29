import { tool } from "ai";
import { z } from "zod";

const references = new Map([
  ["lore", "Lore is a tool-using agent built with TypeScript and Vercel AI SDK."],
  ["stage-01", "Stage one provides a bounded, non-persistent agent invocation."],
]);

export function createReferenceTools() {
  return {
    lookup_reference: tool({
      description: "Look up a fixed local reference by key (lore or stage-01).",
      inputSchema: z.strictObject({ key: z.string().trim().min(1).max(200) }),
      execute: async ({ key }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const value = references.get(key);
        return value === undefined ? { found: false } : { found: true, value };
      },
    }),
  };
}
