import type { ClientConfig } from "pg";
import { isLoopbackHostname } from "./loopback.js";

export function databaseConnectionConfig(
  connectionString: string,
): Pick<ClientConfig, "connectionString" | "ssl"> {
  const invalid = () => new Error("Invalid database connection settings.");
  if (!URL.canParse(connectionString)) throw invalid();
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw invalid();
  if ([...url.searchParams.keys()].some((key) => ["host", "hostaddr"].includes(key.toLowerCase())))
    throw invalid();
  if (isLoopbackHostname(url.hostname)) return { connectionString };

  // Remove URL SSL options so pg cannot override certificate verification or read local key files.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("ssl") || key.toLowerCase() === "uselibpqcompat") {
      url.searchParams.delete(key);
    }
  }
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
}
