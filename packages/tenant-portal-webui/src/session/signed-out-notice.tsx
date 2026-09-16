import { loginHref, type LoginOutcome } from "./sign-in.js";

const MESSAGES: Record<LoginOutcome["kind"], string> = {
  denied: "这个账号还没有加入工作区",
  failed: "登录没有完成，请重试",
  unavailable: "登录暂不可用，请稍后再试",
};

/** 复用 device-notice 的结构：标题、一句说明、登录链接。 */
export function SignedOutNotice(props: {
  readonly outcome: LoginOutcome | null;
  readonly location: { readonly pathname: string; readonly hash: string };
}) {
  return (
    <section className="device-notice" aria-labelledby="device-notice-title">
      <h1 id="device-notice-title">需要登录后才能查看</h1>
      {props.outcome && (
        <p role="status">
          {MESSAGES[props.outcome.kind]}
          {props.outcome.requestId && <small>（请求编号 {props.outcome.requestId}）</small>}
        </p>
      )}
      <a className="primary" href={loginHref(props.location)}>使用 Google 账号登录</a>
    </section>
  );
}
