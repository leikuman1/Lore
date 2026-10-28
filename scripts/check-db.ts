import "dotenv/config";
import pg from "pg";
import { parseEnvironment } from "../src/config/env.js";

async function main() {
  const env = parseEnvironment(process.env);
  if (!env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL in .env to a dedicated Lore development database.");
  }

  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    application_name: "lore-db-check",
    options: "-c default_transaction_read_only=on -c statement_timeout=5000",
  });

  try {
    await client.connect();
    const result = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    const version = Number(result.rows[0]?.server_version_num);
    if (!Number.isInteger(version) || version < 140000) {
      throw new Error("PostgreSQL 14 or newer is required.");
    }
    console.info(`PostgreSQL ${Math.floor(version / 10000)}: connection OK (read-only check).`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (error instanceof Error && error.message.startsWith("Set DATABASE_URL")) {
    console.error(error.message);
  } else {
    console.error(
      `Database check failed${code ? ` (${code})` : ""}. Check the URL and permissions locally.`,
    );
  }
  process.exitCode = 1;
});
