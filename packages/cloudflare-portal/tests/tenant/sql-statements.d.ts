declare module "*/sql-statements.mjs" {
  export function splitSqlStatements(sql: string, file?: string): string[];
}
