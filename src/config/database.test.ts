import pg from "pg";
import { describe, expect, it } from "vitest";
import { databaseConnectionConfig } from "./database.js";

describe("database transport", () => {
  it.each([
    "",
    "?sslmode=disable",
    "?sslmode=no-verify",
    "?ssl=false",
    "?sslmode=require&uselibpqcompat=true",
    "?sslrootcert=private-file&sslkey=private-key",
  ])("enforces verified TLS for remote connections %s", (query) => {
    const config = databaseConnectionConfig(`postgresql://db.example.test/app${query}`);
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(new pg.Client(config)).toHaveProperty("ssl", { rejectUnauthorized: true });
    expect(new URL(config.connectionString ?? "").search).toBe("");
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "preserves local connection policy for %s",
    (host) => {
      const connectionString = `postgresql://${host}/app?sslmode=disable`;
      expect(databaseConnectionConfig(connectionString)).toEqual({ connectionString });
    },
  );

  it("preserves unrelated remote parameters", () => {
    const config = databaseConnectionConfig(
      "postgresql://db.example.test/app?application_name=check&sslmode=require",
    );
    expect(new URL(config.connectionString ?? "").searchParams.get("application_name")).toBe(
      "check",
    );
  });

  it.each([
    "invalid",
    "https://db.example.test/app",
    "postgresql://localhost/app?host=remote.example.test",
    "postgresql://localhost/app?hostaddr=192.0.2.1",
  ])("rejects invalid URLs without echoing values", (url) => {
    expect(() => databaseConnectionConfig(url)).toThrow("Invalid database connection settings.");
  });
});
