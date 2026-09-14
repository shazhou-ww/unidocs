import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createHttpTransport, createMemoryTransport, createTenantPortalClient, sampleSeed,
} from "@unidocs/tenant-portal-client";
import { App } from "./app.js";
import { loadTenantSession, readCsrfCookie } from "./session/bootstrap.js";

const root = createRoot(document.getElementById("root")!);

function renderSignedOutNotice(): void {
  // 复用 app.tsx 的 device-notice 结构，只是换一句文案。
  root.render(
    <StrictMode>
      <section className="device-notice" aria-labelledby="device-notice-title">
        <h1 id="device-notice-title">需要登录后才能查看</h1>
      </section>
    </StrictMode>,
  );
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
  const session = await loadTenantSession();
  if (session.kind === "signed-out") { renderSignedOutNotice(); return; }

  const client = createTenantPortalClient({
    tenantId: session.tenantId,
    transport: createHttpTransport({ baseUrl: window.location.origin, csrfToken: readCsrfCookie }),
  });
  root.render(<StrictMode><App client={client} /></StrictMode>);
}

void bootstrap();
