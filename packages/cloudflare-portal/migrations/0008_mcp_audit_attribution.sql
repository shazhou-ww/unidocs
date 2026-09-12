ALTER TABLE portal_admin_audit
  ADD COLUMN caller_channel TEXT NOT NULL DEFAULT 'admin-webui'
  CHECK (caller_channel IN ('admin-webui', 'mcp'));
ALTER TABLE portal_admin_audit ADD COLUMN oauth_client_handle TEXT;
ALTER TABLE portal_admin_audit ADD COLUMN tool_name TEXT;
CREATE INDEX portal_admin_audit_channel_page
  ON portal_admin_audit(caller_channel, occurred_at DESC, audit_event_id DESC);