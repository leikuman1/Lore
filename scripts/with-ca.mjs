import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const certificate = fileURLToPath(new URL("../certs/supabase-root-2021.crt", import.meta.url));
const result = spawnSync(process.execPath, process.argv.slice(2), {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || certificate,
  },
});

if (result.error) {
  console.error(`Failed to start Node.js: ${result.error.code}`);
}
process.exitCode = result.status ?? 1;
