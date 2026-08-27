import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export function runLocalCompose(composeFile, args = []) {
  const result = spawnSync(
    "docker",
    ["compose", "-f", composeFile, "up", "--build", "--remove-orphans"],
    {
      cwd: dirname(composeFile),
      env: { ...process.env, UNIDOCS_LOCAL_ARGS_JSON: JSON.stringify(args) },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}