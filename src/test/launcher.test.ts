import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it("preserves the child environment, working directory and exit code", async () => {
  const child = spawn(
    process.execPath,
    [
      "scripts/with-ca.mjs",
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),ca:process.env.NODE_EXTRA_CA_CERTS}));process.exitCode=7;",
    ],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: "certs/supabase-root-2021.crt" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.resume();
  const [code] = await once(child, "close");
  expect(code).toBe(7);
  expect(JSON.parse(output)).toEqual({ cwd: process.cwd(), ca: "certs/supabase-root-2021.crt" });
});

it.skipIf(process.platform === "win32")(
  "forwards SIGTERM so the child can shut down gracefully",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "scripts/with-ca.mjs",
        "-e",
        'process.on("SIGTERM",()=>{console.log("stopped");process.exit(0)});console.log("ready");setInterval(()=>{},1000);',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const closed = once(child, "close");
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready") && !child.killed) child.kill("SIGTERM");
    });
    try {
      const [code, signal] = await closed;
      expect(code).toBe(0);
      expect(signal).toBeNull();
      expect(output).toContain("stopped");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
  10_000,
);
