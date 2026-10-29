import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const certificate = fileURLToPath(new URL("../certs/supabase-root-2021.crt", import.meta.url));
const child = spawn(process.execPath, process.argv.slice(2), {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || certificate,
  },
});

const forward = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
const onInterrupt = () => forward("SIGINT");
const onTerminate = () => forward("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

child.on("error", (error) => {
  console.error(`Failed to start Node.js: ${error.code}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
});
