import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createHttpTransport, createMemoryTransport, createTenantPortalClient, sampleSeed,
} from "@unidocs/tenant-portal-client";
import { App } from "./app.js";
import { describeConnectionFailure, loadTenantSession, readCsrfCookie } from "./session/bootstrap.js";

const root = createRoot(document.getElementById("root")!);

function renderNotice(title: string): void {
  // 复用 app.tsx 的 device-notice 结构，只是换一句文案。
  root.render(
    <StrictMode>
      <section className="device-notice" aria-labelledby="device-notice-title">
        <h1 id="device-notice-title">{title}</h1>
      </section>
    </StrictMode>,
  );
}

function renderSignedOutNotice(): void {
  renderNotice("需要登录后才能查看");
}

/**
 * 403（origin 不是 loopback）、500（迁移没跑）、网络错误（worker 没启动）……bootstrap
 * 失败时不能让页面停在空白——之前 `void bootstrap()` 没有 catch，任何一种失败都是白屏。
 * 不 render App，只给出连接失败提示；具体文案交给 describeConnectionFailure，好测。
 */
function renderConnectionFailureNotice(error: unknown): void {
  renderNotice(describeConnectionFailure(error).title);
}

async function bootstrap(): Promise<void> {
  // 离线开发与演示用：内存夹具挡在这个开关后面，不删——见 task 9 background。
  if (import.meta.env.VITE_TENANT_FIXTURE === "memory") {
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: createMemoryTransport({ seed: sampleSeed(), agent: { autoRun: true } }),
    });
    root.render(<StrictMode><App client={client} /></StrictMode>);
    return;
  }

  // portal worker 同源服务这个 webui（两个 WebUI 都编译进 worker，不是独立 dev
  // server——见 stacks/README.md），baseUrl 用当前 origin 即可，cookie 自然随
  // 请求携带。
  try {
    const session = await loadTenantSession();
    if (session.kind === "signed-out") { renderSignedOutNotice(); return; }

    const client = createTenantPortalClient({
      tenantId: session.tenantId,
      transport: createHttpTransport({ baseUrl: window.location.origin, csrfToken: readCsrfCookie }),
    });
    root.render(<StrictMode><App client={client} /></StrictMode>);
  } catch (error) {
    renderConnectionFailureNotice(error);
  }
}

void bootstrap();
