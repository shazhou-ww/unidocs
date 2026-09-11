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

// The mirror image of the test below, and the one `pnpm dev portal` actually
// hits: no document type is selected, so the `Static registrations:` line has
// nothing to list. An empty one reads exactly like the empty `Services:` line
// the guard below exists to suppress — "started and failed" — so the two
// guards have to be symmetric.
test("no document type selected means no Static registrations line", async () => {
  const { stdout, stderr } = await runDev(["portal", "--cas", "local", "--fonts", "off"], {
    platform: "cloudflare",
    stubs: true,
  });

  expect(stdout).not.toContain("Static registrations:");
  expect(stdout).toContain("Services: portal");
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

/**
 * Every `STUB spawn` line the run printed, as objects. The frontend loops are
 * the one place on this branch where live, user-facing behaviour was
 * refactored, so they are asserted from the outside: what was spawned, in
 * which package, on which port, and with which gateway URL.
 */
function viteSpawns(stdout) {
  return stdout.split("\n")
    .filter(line => line.startsWith("STUB spawn "))
    .map(line => JSON.parse(line.slice("STUB spawn ".length)))
    .filter(spawned => spawned.args[0] === "vite");
}

// Deleting the doc-type frontend loop, or dropping GATEWAY_URL from the spawn
// env, used to leave the whole suite green — and a web-psd whose /gw proxy
// points nowhere looks like a working dev server until the first API call.
test("a selected doc type's Vite frontend is started in its own package, with the gateway URL its proxy needs", async () => {
  const { stdout, stderr } = await runDev(["psd", "--cas", "local", "--fonts", "off"], {
    platform: "cloudflare",
    stubs: true,
  });

  const psd = viteSpawns(stdout).find(spawned => spawned.cwd.endsWith("/packages/web-psd"));
  expect(psd, `no web-psd Vite spawn in:\n${stdout}`).toBeDefined();
  expect(psd.args).toEqual(["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  expect(psd.gatewayUrl).toBe("http://127.0.0.1:8787");
  expect(stdout).toContain("psd web  http://127.0.0.1:5173");
  expect(stderr).toBe("");
});

// The offset exists so both stacks can run at once without fighting over 5173;
// it is arithmetic on a constant, which is exactly the kind of thing a
// refactor silently drops.
test("the Azure stack's doc-type frontend takes the fixed port offset and the Azure gateway", async () => {
  const { stdout, stderr } = await runDev(["psd", "--cas", "local", "--fonts", "off"], {
    platform: "azure",
    stubs: true,
  });

  const psd = viteSpawns(stdout).find(spawned => spawned.cwd.endsWith("/packages/web-psd"));
  expect(psd, `no web-psd Vite spawn in:\n${stdout}`).toBeDefined();
  expect(psd.args).toContain("6173");
  expect(psd.gatewayUrl).toBe("http://127.0.0.1:41787");
  expect(stderr).toBe("");
});

/**
 * The service frontend loop, exercised against a synthetic component (no
 * SERVICE_TARGETS row declares `web` yet — see the fixture). It must start the
 * component on exactly the same terms as a doc-type frontend, including
 * GATEWAY_URL, and *without* the Azure offset, which does not apply to
 * Cloudflare-only services.
 */
test("a service frontend is started on the same terms as a doc-type one", async () => {
  const { stdout, stderr } = await runDev(["portal", "--cas", "local", "--fonts", "off"], {
    platform: "cloudflare",
    stubs: true,
    env: { UNIDOCS_TEST_STUB_SERVICE_FRONTEND: "1" },
  });

  const webui = viteSpawns(stdout).find(spawned => spawned.cwd.endsWith("/packages/stub-webui"));
  expect(webui, `no service-frontend Vite spawn in:\n${stdout}`).toBeDefined();
  expect(webui.args).toEqual(["vite", "--host", "127.0.0.1", "--port", "5199", "--strictPort"]);
  expect(webui.gatewayUrl).toBe("http://127.0.0.1:8787");
  expect(stdout).toContain("portal-webui web http://127.0.0.1:5199");
  expect(stderr).toBe("");
});
