CREATE TABLE portal_mcp_authorization_transaction_consumptions (
  transaction_hash TEXT PRIMARY KEY NOT NULL CHECK (length(transaction_hash) = 64),
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > consumed_at)
);

CREATE INDEX portal_mcp_authorization_transaction_consumption_expiry
  ON portal_mcp_authorization_transaction_consumptions(expires_at);