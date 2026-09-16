import seal from "../assets/studio-seal.svg";
import { loginHref, type LoginOutcome } from "./sign-in.js";

/**
 * 未登录时的整页。构图沿用外壳左上角那一组：印章 + 衬线字标 + 绿点工作区行，
 * 因为那是这个产品的身份所在——登录页就是那个角落单独占满一页，而不是一张
 * 居中卡片（卡片在这个界面里是文档，不是 chrome）。
 */
const MESSAGES: Record<LoginOutcome["kind"], string> = {
  // 自助注册之后，denied 只剩这一种含义：邮箱已经绑在另一个 Google 身份上
  // （或邀请晚于这次登录确认）。"还没有加入工作区"已经不成立了。
  denied: "这个邮箱已经绑定了另一个 Google 账号",
  failed: "登录没有完成，请重试",
  unavailable: "登录暂时不可用，请稍后再试",
};

/** denied / failed 是拒绝，用红点；unavailable 是系统状态，用灰点。 */
const TONE: Record<LoginOutcome["kind"], string> = {
  denied: "sign-in-dot-refused",
  failed: "sign-in-dot-refused",
  unavailable: "sign-in-dot-idle",
};

export function SignedOutNotice(props: {
  readonly outcome: LoginOutcome | null;
  readonly location: { readonly pathname: string; readonly hash: string };
}) {
  return (
    <main className="sign-in">
      <section className="sign-in-block" aria-labelledby="sign-in-title">
        <div className="brand">
          <span className="brand-mark"><img src={seal} alt="" /></span>
          UniDocs
        </div>
        <div className="workspace">个人工作空间</div>

        <h1 id="sign-in-title">进入你的工作空间</h1>
        <p className="sign-in-lede">首次登录会为你创建一个新空间。</p>

        <a className="primary sign-in-action" href={loginHref(props.location)}>
          使用 Google 账号登录
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
      </section>
    </main>
  );
}
