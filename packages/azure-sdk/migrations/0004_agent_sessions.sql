BEGIN;

-- agent 的对话历史与"正在跑"租约。
--
-- 与 doc_sessions 同一套主键 (tenant_id, doc_type, session_id):这个代码库里
-- 一个 session 就是一份文档。外键跟着删,免得文档没了历史还留着。
--
-- 历史与租约刻意放同一行:一次 /run 的第一个动作是"拿到历史并宣告我在跑",
-- 两件事必须原子。分两张表就要么开事务、要么容忍中间态。
CREATE TABLE IF NOT EXISTS agent_sessions (
  tenant_id     TEXT        NOT NULL,
  doc_type      TEXT        NOT NULL,
  session_id    TEXT        NOT NULL,
  history       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- NULL = 没人在跑。过去的时间 = 上一个持有者崩了,租约已过期,可以抢。
  running_until TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, doc_type, session_id),
  CONSTRAINT agent_sessions_session_fk
    FOREIGN KEY (tenant_id, doc_type, session_id)
    REFERENCES doc_sessions (tenant_id, doc_type, session_id)
    ON DELETE CASCADE
);

COMMIT;
