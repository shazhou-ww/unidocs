import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function parseDevArgs(argv, env = process.env) {
  const options = {
    casMode: env.UNIDOCS_CAS_MODE ?? "remote",
    docTypes: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--cas") options.casMode = argv[++index];
    else options.docTypes.push(arg);
  }
  if (options.casMode !== "remote" && options.casMode !== "local") {
    throw new Error("--cas must be remote or local");
  }
  return options;
}

export async function loadRemoteCasConfig({ root, env = process.env }) {
  const origin = normalizeOrigin(env.UNIDOCS_CAS_ORIGIN ?? "https://unicas.shazhou.work");
  const credentialFile = resolve(
    root,
    env.UNIDOCS_CAS_STACK_CREDENTIAL ?? ".wrangler/unidocs/stack.json",
  );
  let fixture;
  try {
    fixture = JSON.parse(await readFile(credentialFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Remote UniCAS credential not found: ${credentialFile}. Register a developer stack or use --cas local.`,
      );
    }
    throw new Error(`Cannot read remote UniCAS credential ${credentialFile}: ${error.message}`);
  }
  for (const field of ["stackId", "issuer", "audience", "kid", "privateKeyPkcs8", "jwks"]) {
    if (!fixture[field]) throw new Error(`Remote UniCAS credential is missing ${field}: ${credentialFile}`);
  }
  if (!Array.isArray(fixture.jwks.keys) || fixture.jwks.keys.length === 0) {
    throw new Error(`Remote UniCAS credential has no JWKS keys: ${credentialFile}`);
  }
  return { origin, credentialFile, stackFixture: fixture };
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("UNIDOCS_CAS_ORIGIN must be an origin without a path, query, or fragment");
  }
  return url.origin;
}