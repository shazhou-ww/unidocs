/**
 * `scripts/dev.mjs` run for real, with its collaborators stubbed by a module
 * loader (tests/unit/scripts/fixtures/dev-stub-hooks.mjs). What is under test
 * here is wiring — which selection reaches `startLocalRuntime`, in what order
 * the pre-flight checks run, which lines get printed — so it is exercised
 * through the actual entry script rather than through an extracted helper.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEV_SCRIPT = fileURLToPath(new URL("../../../scripts/dev.mjs", import.meta.url));
const HOOKS = new URL("./fixtures/dev-stub-hooks.mjs", import.meta.url).href;
const REGISTER_STUBS = "data:text/javascript," + encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(HOOKS)});`,
);

/**
 * Runs dev.mjs to completion. A successful start never exits on its own (it
 * waits for Ctrl+C), so the "Ctrl+C to stop." banner is the cue to send SIGINT
 * — which is also the shutdown path a developer takes. The banner is printed
 * a few statements before the SIGINT handler is installed, so a run torn down
 * this way may exit on the signal instead of through `process.exit(0)`; the
 * successful runs therefore assert on the banner and an empty stderr rather
 * than on an exit code.
 */
function runDev(args, { platform, env = {}, stubs = false, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(stubs ? ["--import", REGISTER_STUBS] : []), DEV_SCRIPT, ...args], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Keeps this test from truncating the developer's own .dev-*.log.
        UNIDOCS_DEV_LOG: "off",
        ...env,
        UNIDOCS_LOCAL_PLATFORM: platform,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`dev.mjs did not finish in ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Ctrl+C to stop.")) child.kill("SIGINT");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// PATH is emptied so the `docker info` probe cannot succeed: if the
// availability check ever moves below it — or disappears — this run reports
// the Docker failure instead, and the assertions below say so.
test("the portal is refused on Azure by name, before the Docker probe runs", async () => {
  const { code, stdout, stderr } = await runDev(["portal", "--cas", "local", "--fonts", "off"], {
    platform: "azure",
    env: { PATH: "" },
  });

  expect(stderr.split("\n")[0]).toBe(
    "portal is not available on the unidocs-azure stack yet (packages/azure-portal does not exist yet).",
  );
  expect(stderr).not.toContain("requires Docker");
  expect(stdout).toBe("");
  expect(code).toBe(1);
});

test("a selected service reaches startLocalRuntime and is announced on its own line", async () => {
  const { stdout, stderr } = await runDev(["portal", "--cas", "local", "--fonts", "off"], {
    platform: "cloudflare",
    stubs: true,
  });

  expect(stdout).toContain('STUB startLocalRuntime {"docTypes":[],"services":["portal"]}');
  expect(stdout).toContain("Services: portal");
  expect(stdout).toContain("Ctrl+C to stop.");
  expect(stderr).toBe("");
});

// The `Services:` line is conditional: an empty one reads like something was
// started and failed.
test("no service selected means an empty services list and no Services line", async () => {
  const { stdout, stderr } = await runDev(["markdown", "--cas", "local", "--fonts", "off"], {
    platform: "cloudflare",
    stubs: true,
  });

  expect(stdout).toContain('STUB startLocalRuntime {"docTypes":["markdown"],"services":[]}');
  expect(stdout).toContain("Static registrations: markdown");
  expect(stdout).not.toContain("Services:");
  expect(stdout).toContain("Ctrl+C to stop.");
  expect(stderr).toBe("");
});

/**
 * Guards the trap that `assertServicesAvailable` currently hides: Azure's
 * "no arguments means every document type" default must key off the *parsed*
 * document types, not off raw argv. With the availability gate stubbed out —
 * standing in for the day some service does support Azure — naming only a
 * service must still boot every Azure document type, not none of them.
 */
test("naming only a service on Azure still starts every Azure document type", async () => {
  const { stdout, stderr } = await runDev(["portal", "--cas", "local", "--fonts", "off"], {
    platform: "azure",
    stubs: true,
    env: { UNIDOCS_TEST_STUB_SERVICE_AVAILABILITY: "1" },
  });

  expect(stdout).toContain('STUB startAzureRuntime {"docTypes":["docx","markdown","psd"]}');
  expect(stdout).toContain("Ctrl+C to stop.");
  expect(stderr).toBe("");
});
