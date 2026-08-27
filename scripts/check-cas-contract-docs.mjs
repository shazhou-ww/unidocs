import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATION_START = "<!-- cas-contract-docs: migration-start -->";
const MIGRATION_END = "<!-- cas-contract-docs: migration-end -->";

const RULES = [
  {
    id: "owner-assignment",
    pattern: /\b(?:rootAssignments|cas_root_owners|CasRootAssignmentsRequest|CasRootAssignment)\b|\/root-assignments\b/,
  },
  {
    id: "portable-node-route",
    pattern: /\/_internal\/nodes(?:\/|\b)|\b(?:readPortableNode|leasePortableNode|CasReadPortableNode|CasLeasePortableNode)\b/,
  },
  {
    id: "shared-cas-key",
    pattern: /\bCAS_ACCESS_KEY\b|--cas-access-key\b|\bcas-access-key\b/,
  },
  {
    id: "tenantless-root-route",
    pattern: /\/_internal\/root-refs\b/,
  },
  {
    id: "stale-admin-route",
    pattern: /\/stacks\/\{stackId\}\/admin\/|\/admin\/cas\/|\/tenants\/\{tenantId\}\/(?:cas\/)?admin\//,
  },
];

function isHistoricalDocument(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  return normalized.startsWith("docs/superpowers/") || normalized.includes("/docs/plans/");
}

function walkMarkdown(root, directory, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory).sort()) {
    if ([".git", "dist", "node_modules", ".wrangler"].includes(entry)) continue;
    const absolutePath = join(directory, entry);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      walkMarkdown(root, absolutePath, output);
    } else if (entry.endsWith(".md") && !isHistoricalDocument(relativePath)) {
      output.push(relativePath);
    }
  }
}

export function currentContractDocuments(root) {
  const documents = [];
  if (existsSync(join(root, "README.md"))) documents.push("README.md");
  for (const directory of ["docs", "packages", "stacks", "unicas-packages"]) {
    walkMarkdown(root, join(root, directory), documents);
  }
  return [...new Set(documents)].sort();
}

export function inspectContractDocument(file, source) {
  const findings = [];
  let migrationDepth = 0;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.includes(MIGRATION_START)) {
      migrationDepth += 1;
      continue;
    }
    if (line.includes(MIGRATION_END)) {
      migrationDepth -= 1;
      if (migrationDepth < 0) {
        findings.push({ file, line: index + 1, rule: "migration-marker", text: "unexpected migration-end" });
        migrationDepth = 0;
      }
      continue;
    }
    if (migrationDepth > 0) continue;

    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file, line: index + 1, rule: rule.id, text: line.trim() });
      }
    }
  }

  if (migrationDepth !== 0) {
    findings.push({ file, line: source.split(/\r?\n/).length, rule: "migration-marker", text: "unclosed migration-start" });
  }
  return findings;
}

export function checkCasContractDocs(root) {
  return currentContractDocuments(root).flatMap((file) =>
    inspectContractDocument(file, readFileSync(join(root, file), "utf8")),
  );
}

function main() {
  const root = process.cwd();
  const documents = currentContractDocuments(root);
  const findings = documents.flatMap((file) =>
    inspectContractDocument(file, readFileSync(join(root, file), "utf8")),
  );
  if (findings.length === 0) {
    console.log(`CAS contract docs check passed (${documents.length} files).`);
    return;
  }

  console.error("Retired CAS contract guidance found outside a marked migration section:");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();