import "dotenv/config";
import { parseEnvironment } from "../src/config/env.js";

const dependencies = ["ai", "@ai-sdk/openai", "@ai-sdk/mcp", "hono", "pg", "graphile-worker"];

function main() {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Lore currently supports Node.js 24.x. See .nvmrc.");
  }
  const env = parseEnvironment(process.env);

  console.info(`Node.js ${process.versions.node}: OK`);
  for (const dependency of dependencies) {
    import.meta.resolve(dependency);
    console.info(`${dependency}: installed`);
  }
  console.info(`HTTP: ${env.HOST}:${env.PORT}`);
  console.info(
    `DATABASE_URL: ${env.DATABASE_URL ? "configured (not connected)" : "not configured"}`,
  );
  console.info(
    `Model settings: ${env.MODEL_PROVIDER === "mock" ? "offline mock" : env.MODEL_PROVIDER === "magpie" ? `Magpie (${env.MODEL_API}, not connected)` : "no supported model configured"}`,
  );
  console.info("Environment check complete. No database connection or model request was made.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Environment check failed.");
  process.exitCode = 1;
}
