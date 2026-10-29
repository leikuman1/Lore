import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { invocationInputSchema } from "../agent/contracts.js";
import { SessionError, type WorkspaceSessions } from "../agent/sessions.js";
import { workspacePage } from "../web/page.js";
import { DirectoryPickerError } from "../workspace/picker.js";

const inputSchema = invocationInputSchema.extend({ sessionId: z.uuid() });
const emptySchema = z.strictObject({});

export function mountWorkspace(
  app: Hono,
  sessions: WorkspaceSessions,
  picker: (signal?: AbortSignal) => Promise<string | null>,
  readBody: (request: Request) => Promise<unknown>,
) {
  app.use("/workspace/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    if (context.req.method !== "GET") {
      const origin = context.req.header("origin");
      const fetchSite = context.req.header("sec-fetch-site");
      if (
        origin !== new URL(context.req.url).origin ||
        (fetchSite && fetchSite !== "same-origin")
      ) {
        return context.json(
          { error: { code: "ORIGIN_NOT_ALLOWED", message: "仅允许从本机页面发起操作。" } },
          403,
        );
      }
    }
    await next();
  });

  app.get("/", (context) => {
    const nonce = randomBytes(18).toString("base64");
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    return context.html(workspacePage.replaceAll("__LORE_NONCE__", nonce));
  });
  app.get("/workspace/session", (context) => context.json(sessions.snapshot()));
  app.get("/workspace/run/:id", (context) =>
    context.json(sessions.getRun(context.req.param("id"))),
  );

  app.post("/workspace/select", async (context) => {
    emptySchema.parse(await readBody(context.req.raw));
    return context.json(await sessions.select(picker, context.req.raw.signal));
  });
  app.post("/workspace/reset", async (context) => {
    emptySchema.parse(await readBody(context.req.raw));
    return context.json(sessions.reset());
  });
  app.post("/workspace/invoke", async (context) => {
    const input = inputSchema.parse(await readBody(context.req.raw));
    return context.json(sessions.start(input.sessionId, input.message), 202);
  });
  app.post("/workspace/run/:id/cancel", async (context) => {
    emptySchema.parse(await readBody(context.req.raw));
    return context.json(sessions.cancel(context.req.param("id")));
  });
  app.onError((error, context) => {
    if (error instanceof SessionError)
      return context.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof DirectoryPickerError)
      return context.json({ error: { code: error.code, message: error.message } }, 409);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return context.json({ error: { code: "INVALID_REQUEST", message: "请求格式不正确。" } }, 400);
    return context.json(
      { error: { code: "WORKSPACE_ERROR", message: "工作区操作失败，请检查目录和请求。" } },
      400,
    );
  });
}
