/**
 * 「5433 上坐着的是不是我们自己那个容器」。
 *
 * 由来:`pnpm dev unidocs-azure` 的预检问的是「5433 空不空」,而 Ctrl-C 之后
 * 的稳态恰恰是「我们上一轮的 Postgres 容器还在 5433 上」——`docker compose
 * up -d` 本来幂等、完全可以复用它,却被预检先一步否掉。于是每次重启都要
 * 手动 `pnpm azure:down`。
 *
 * 但预检不能简单删掉:它防的是**认错人**。连接串
 * `postgres://…@localhost:5433` 不关心对面是谁,陌生人的 Postgres 一样连得
 * 上,migrations 会直接往别人的库上跑。所以正确的问题不是「空不空」,是
 * 「是不是我们」——同一个端口只能被一个进程绑定,所以「我们 compose 项目里
 * 的服务正在跑、且发布着这个端口」就是身份证明。
 *
 * 输入是 `docker compose ps --format json` 的原样输出(JSONL,一行一个容器)。
 */
import { expect, test } from "vitest";
import { composeOwnsPort } from "../../../stacks/unidocs-azure/local/compose-status.mjs";

/** 真实 `docker compose ps --format json` 输出的最小骨架,只留判定用得上的字段。 */
function psLine({ service = "postgres", state = "running", published = 5433 } = {}) {
  return JSON.stringify({
    Name: `azure-sdk-${service}-1`,
    Service: service,
    State: state,
    Publishers: [
      { URL: "0.0.0.0", TargetPort: 5432, PublishedPort: published, Protocol: "tcp" },
      { URL: "::", TargetPort: 5432, PublishedPort: published, Protocol: "tcp" },
    ],
  });
}

test("我们的容器正在跑且发布着这个端口 —— 认领它", () => {
  expect(composeOwnsPort(psLine(), 5433)).toBe(true);
});

test("容器已停 —— 端口不是它占的,不认领", () => {
  expect(composeOwnsPort(psLine({ state: "exited" }), 5433)).toBe(false);
});

test("从没起过(空输出)—— 不认领", () => {
  expect(composeOwnsPort("", 5433)).toBe(false);
});

test("在跑,但发布的是别的端口 —— 5433 上的是陌生人,不认领", () => {
  expect(composeOwnsPort(psLine({ published: 15433 }), 5433)).toBe(false);
});

test("输出不是合法 JSON —— 退回严格检查,而不是让 pnpm dev 崩掉", () => {
  expect(composeOwnsPort("Cannot connect to the Docker daemon", 5433)).toBe(false);
});

test("多行输出里只要有一个在跑的容器发布着它就算 —— compose 项目可以不止一个服务", () => {
  const out = [
    psLine({ service: "azurite", state: "exited", published: 10000 }),
    psLine({ service: "postgres", state: "running", published: 5433 }),
  ].join("\n");

  expect(composeOwnsPort(out, 5433)).toBe(true);
});
