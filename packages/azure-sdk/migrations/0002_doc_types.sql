-- doc type 服务启动时把自己的内部 FQDN upsert 进来,网关查它做路由。
-- 取代原先「网关靠 {TYPE}_WORKER_URL 环境变量找服务」的做法 —— 那个做法
-- 使得新增一个 doc type 必须改网关的环境变量,即必须重新部署网关。
--
-- 只 upsert,永不删除:一个 doc type 的 N 个副本共用同一个 ingress FQDN,
-- 写的是同一行同一值。关停时注销是错的 —— 一次滚动更新会在中间时刻把整个
-- doc type 抹掉,而此时其它副本仍在服务。
CREATE TABLE doc_types (
  doc_type   TEXT PRIMARY KEY,
  worker_url TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
