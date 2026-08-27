const dockerIndex = process.argv.indexOf("--docker", 2);
if (dockerIndex !== -1) {
  process.argv.splice(dockerIndex, 1);
  console.log("UniDocs Azure already uses Docker Compose for local Postgres.");
}

process.env.UNIDOCS_LOCAL_PLATFORM = "azure";
await import("../../../scripts/dev.mjs");