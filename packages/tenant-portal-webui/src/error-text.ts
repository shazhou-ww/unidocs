/**
 * 错误码映射成中文文案。不要把 code 弹给用户（spec §7）。
 */
import { PlatformError } from "@unidocs/tenant-portal-client";

const TEXT: Readonly<Record<string, string>> = {
  version_conflict: "当前版本已经变了，请刷新后再试。",
  pong_watermark_conflict: "Agent 正在处理这一处，请稍后再试。",
  idempotency_conflict: "这条评论已经用另一份内容发送过了，请新写一条。",
  not_found: "这件作品或这一处已经不存在了。",
  forbidden: "你没有访问这件作品的权限。",
  unauthorized: "登录已失效，请重新登录。",
  limit_exceeded: "操作太频繁，请稍后再试。",
  invalid_request: "这条评论没能被接受，请检查内容后重试。",
  location_contract_violation: "这个位置在当前文档类型下不被接受。",
  content_unavailable: "内容暂时读不到，请稍后再试。",
  transport_failure: "网络不通，请检查连接后重试。",
};

export function errorText(error: unknown): string {
  if (error instanceof PlatformError) return TEXT[error.code] ?? "操作没有成功，请稍后再试。";
  return "操作没有成功，请稍后再试。";
}
