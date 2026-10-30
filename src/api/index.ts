import "dotenv/config";
import { serve } from "@hono/node-server";
import { parseEnvironment } from "../config/env.js";
import { createApp } from "./app.js";

const env = parseEnvironment(process.env);
const app = createApp({ env });

const server = serve(
  {
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  },
  () => console.info(`Lore listening on http://${env.HOST}:${env.PORT}`),
);

function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  const closing = app.close();
  server.close(() => {
    void closing.finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
