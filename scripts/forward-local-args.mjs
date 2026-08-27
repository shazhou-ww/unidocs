export function applyForwardedLocalArgs(argv = process.argv, env = process.env) {
  const encoded = env.UNIDOCS_LOCAL_ARGS_JSON;
  if (!encoded) return;
  const args = JSON.parse(encoded);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("UNIDOCS_LOCAL_ARGS_JSON must contain a JSON string array");
  }
  argv.push(...args);
  delete env.UNIDOCS_LOCAL_ARGS_JSON;
}