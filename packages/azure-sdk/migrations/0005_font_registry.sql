-- 租户级字体登记表。作用域是 (stack_id, tenant_id) —— 不含 session:
-- 同一租户下所有 psd 文档共用一套字体。
--
-- 带 stack_id 不是冗余:字体字节在 CAS 里的键是
-- stacks/{stackId}/tenants/{tenantId}/nodes-v2/{hash},stack 和 tenant 两段
-- 都在键里。换一个 stack 那些字节就已经不在了,索引必须跟着换作用域,
-- 否则会得到一张指向不存在字节的索引,而那种失效是静默的。
CREATE TABLE IF NOT EXISTS font_registry (
  stack_id         text    NOT NULL,
  tenant_id        text    NOT NULL,
  post_script_name text    NOT NULL,
  family           text    NOT NULL,
  hash             text    NOT NULL,
  units_per_em     integer NOT NULL,
  coverage         jsonb   NOT NULL,
  PRIMARY KEY (stack_id, tenant_id, post_script_name)
);
