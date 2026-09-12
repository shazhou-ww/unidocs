CREATE TABLE portal_mcp_code_consumptions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  consumed_at INTEGER NOT NULL CHECK (consumed_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > consumed_at)
);
CREATE INDEX portal_mcp_code_consumption_expiry
  ON portal_mcp_code_consumptions(expires_at);