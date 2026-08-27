/** stdout/stderr output helpers. The stdio MCP mode never uses these on stdout. */

import { CliError } from "./errors.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printText(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`unicas: ${message}\n`);
}

export function fail(message: string, exitCode = 1): never {
  throw new CliError(message, exitCode);
}
