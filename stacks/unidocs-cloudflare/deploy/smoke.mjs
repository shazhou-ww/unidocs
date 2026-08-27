const args = process.argv.slice(2);
const gatewayIndex = args.indexOf("--gateway");
const gateway = gatewayIndex === -1 ? undefined : args[gatewayIndex + 1];

if (!gateway) {
  console.error("Usage: pnpm smoke unidocs-cloudflare --gateway <url>");
  process.exit(1);
}

const response = await fetch(gateway, { redirect: "manual" });
if (response.status >= 500) {
  throw new Error(`Cloudflare Gateway readiness failed: ${response.status}`);
}
console.log(`Cloudflare Gateway reachable: ${response.status}`);