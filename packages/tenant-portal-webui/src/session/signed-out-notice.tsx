import { Bot } from "lucide-react";
import seal from "../assets/studio-seal.svg";
import { loginHref, type LoginOutcome } from "./sign-in.js";

/**
 * 未登录整页，照 docs/design 的登录页稿实现：左侧 640px 表单栏 + 右侧说明栏。
 * 稿子里的 Microsoft 登录、服务条款/隐私政策链接、「申请开通」入口都没有落地——
 * 系统里只有 Google 一种身份源，那几个页面也不存在，放上去就是死链。
 * 右栏两张卡片是产品说明的示意，不是真实数据。
 */
const MESSAGES: Record<LoginOutcome["kind"], string> = {
  // 自助注册之后 denied 只剩这一种含义：邮箱已绑在另一个 Google 身份上
  // （或邀请晚于这次登录确认）。
  denied: "这个邮箱已经绑定了另一个 Google 账号",
  failed: "登录没有完成，请重试",
  unavailable: "登录暂时不可用，请稍后再试",
};

const TONE: Record<LoginOutcome["kind"], string> = {
  denied: "sign-in-dot-refused",
  failed: "sign-in-dot-refused",
  unavailable: "sign-in-dot-idle",
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="sign-in-provider-mark" aria-hidden="true">
      <path fill="#4285F4" d="M23.04 12.26c0-.82-.07-1.6-.21-2.36H12v4.47h6.19a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.17-2 3.43-4.95 3.43-8.49Z" />
      <path fill="#34A853" d="M12 24c3.1 0 5.7-1.03 7.61-2.79l-3.72-2.89c-1.03.7-2.35 1.11-3.89 1.11-2.99 0-5.53-2.02-6.43-4.74H1.72v3c1.89 3.76 5.78 6.31 10.28 6.31Z" />
      <path fill="#FBBC05" d="M5.57 14.69a7.2 7.2 0 0 1 0-4.6v-3H1.72a11.96 11.96 0 0 0 0 10.6l3.85-3Z" />
      <path fill="#EA4335" d="M12 4.75c1.69 0 3.2.58 4.39 1.72l3.29-3.29C17.7 1.2 15.1 0 12 0 7.5 0 3.61 2.55 1.72 6.31l3.85 3c.9-2.72 3.44-4.56 6.43-4.56Z" />
    </svg>
  );
}

export function SignedOutNotice(props: {
  readonly outcome: LoginOutcome | null;
  readonly location: { readonly pathname: string; readonly hash: string };
}) {
  return (
    <main className="sign-in">
      <section className="sign-in-form" aria-labelledby="sign-in-title">
        <div className="brand sign-in-brand">
          <span className="brand-mark"><img src={seal} alt="" /></span>
          UniDocs
        </div>

        <div className="sign-in-body">
          <h1 id="sign-in-title">登录</h1>
          <p className="sign-in-lede">进入你的工作空间，继续未完的讨论。</p>

          <a className="sign-in-provider" href={loginHref(props.location)}>
            <GoogleMark />
            使用 Google 账号继续
          </a>

          {props.outcome && (
            <p className="sign-in-outcome" role="status">
              <span className={`sign-in-dot ${TONE[props.outcome.kind]}`} aria-hidden="true" />
              <span>
                {MESSAGES[props.outcome.kind]}
                {props.outcome.requestId && (
                  <small className="sign-in-request">请求编号 {props.outcome.requestId}</small>
                )}
              </span>
            </p>
          )}

          <p className="sign-in-note">首次登录会自动创建你的工作空间。</p>
        </div>
      </section>

      <aside className="sign-in-pitch">
        <div>
          <div className="workspace">你要做的只有评论</div>
          <p className="sign-in-pitch-lede">
            圈一处，说一句，发出去。Agent 在后台自动接手，改完回你一条回复，必要时带一个新版本。
          </p>
        </div>

        <div className="sign-in-samples" aria-hidden="true">
          <article className="sign-in-sample">
            <div className="sign-in-sample-head">
              <span className="sign-in-type">MD</span>
              <strong>UniDocs · 产品构想</strong>
              <span className="sign-in-pending">3 处待回复</span>
            </div>
            <p>为人和 Agent 一起创作而设计。每一件作品都可以被持续阅读、讨论和迭代。</p>
          </article>

          <article className="sign-in-sample sign-in-sample-agent">
            <div className="sign-in-sample-head">
              <span className="sign-in-agent-mark"><Bot size={14} aria-hidden="true" /></span>
              <strong>Agent 回复了 3 处评论</strong>
              <span className="sign-in-version">→ v4</span>
            </div>
            <p>已合并两段引用说明，并按你的措辞改写。</p>
          </article>
        </div>
      </aside>
    </main>
  );
}
