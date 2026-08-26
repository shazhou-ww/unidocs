import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
} from "jose";

const DEFAULT_OUTPUT = ".wrangler/capability/local.json";
const DEFAULT_ISSUER = "unidocs-gateway:local";

export function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    issuer: DEFAULT_ISSUER,
    kid: `local-${Date.now().toString(36)}`,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--output") options.output = requiredValue(argv, ++index, flag);
    else if (flag === "--issuer") options.issuer = requiredValue(argv, ++index, flag);
    else if (flag === "--kid") options.kid = requiredValue(argv, ++index, flag);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

export async function generateLocalCapabilityKeys(options) {
  const output = resolve(options.output);
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const fixture = {
    issuer: options.issuer,
    algorithm: "ES256",
    kid: options.kid,
    privateKeyPkcs8: await exportPKCS8(pair.privateKey),
    jwks: {
      keys: [{ ...publicJwk, kid: options.kid, alg: "ES256", use: "sig" }],
    },
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { output, issuer: options.issuer, kid: options.kid };
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const result = await generateLocalCapabilityKeys(parseArgs(process.argv.slice(2)));
  console.log(`Generated local capability fixture: ${result.output}`);
  console.log(`issuer=${result.issuer} kid=${result.kid}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}