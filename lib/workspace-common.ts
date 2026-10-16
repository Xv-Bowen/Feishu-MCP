import { AppError, boundedInteger } from "./core";
import { randomString, seal, sha256, unseal } from "./crypto";
import { accessToken, type Runtime } from "./feishu";

export type Arguments = Record<string, unknown>;
export type Schema = Record<string, unknown>;
export const stringField = (description: string, maxLength = 2048): Schema => ({ type: "string", description, minLength: 1, maxLength });
export const pagingFields = { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, page_token: stringField("上一页的 page_token", 4096) };
export const requestField = stringField("本次写入唯一请求标识，使用随机 UUID；重试同一操作必须保留此值，新的操作使用新值。", 100);
export function tool(name: string, title: string, description: string, properties: Record<string, Schema>, required: string[], write = false, destructive = false) {
  return { name, title, description, inputSchema: { type: "object", properties: { ...properties, ...(write ? { request_id: requestField } : {}) }, required: [...required, ...(write ? ["request_id"] : [])], additionalProperties: false }, annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write, openWorldHint: false } };
}
export function text(value: unknown, label: string, maximum = 20000, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || value.includes("\0")) throw new AppError("invalid_input", `${label}格式无效或过长。`);
  return value;
}
export function identifier(value: unknown, label = "资源 ID", pattern = /^[A-Za-z0-9_-]{8,100}$/): string {
  const result = text(value, label, 200);
  if (!pattern.test(result)) throw new AppError("invalid_input", `${label}格式无效。`);
  return result;
}
export function resourceToken(value: unknown, paths: string[]): string {
  let token = text(value, "飞书链接或资源 token", 2048);
  if (token.includes(":")) {
    let url: URL; try { url = new URL(token); } catch { throw new AppError("invalid_input", "资源链接无效。"); }
    if (url.protocol !== "https:" || url.username || url.password || !/^(?:[a-z0-9-]+\.)*(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(url.hostname)) throw new AppError("invalid_input", "请使用飞书或 Lark 的 HTTPS 资源链接。");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || !paths.includes(parts[0])) throw new AppError("invalid_input", `此工具支持 ${paths.join("、")} 链接，请先解析知识库链接取得资源 token。`);
    token = parts[1];
  }
  return identifier(token);
}
export function pagination(args: Arguments, maximum = 100) {
  const params = new URLSearchParams({ page_size: String(boundedInteger(args.limit, 50, 1, maximum)) });
  if (args.page_token !== undefined) params.set("page_token", text(args.page_token, "分页游标", 4096));
  return params;
}
export function pageResult(data: Record<string, unknown>) {
  return { ...data, complete: data.has_more !== true, page_token: data.has_more === true ? data.page_token || null : null };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Arguments)[key])).join(",") + "}";
  return JSON.stringify(value);
}

// Claim before any external write. Results are encrypted and bound to the user;
// an uncertain result is never blindly replayed against the provider.
export async function writeOnce(env: Runtime, user: string, name: string, args: Arguments, scopes: string[], action: (token: string) => Promise<unknown>) {
  const requestId = identifier(args.request_id, "请求标识", /^[A-Za-z0-9_-]{8,100}$/);
  await accessToken(env, user, scopes);
  if (!env.DB || !env.TOKEN_ENCRYPTION_KEY) throw new AppError("configuration_required", "写入存储尚未就绪。", 503);
  const key = await sha256(`${user}\0${name}\0${requestId}`), payloadHash = await sha256(canonical(args));
  const claim = randomString(18), stamp = Math.floor(Date.now() / 1000);
  const inserted = await env.DB.prepare("INSERT INTO feishu_write_operations (key_hash,user_id,tool_name,payload_hash,claim,status,created_at) VALUES (?,?,?,?,?,'pending',?) ON CONFLICT(key_hash) DO NOTHING RETURNING key_hash").bind(key, user, name, payloadHash, claim, stamp).first();
  if (!inserted) {
    const previous = await env.DB.prepare("SELECT payload_hash,status,encrypted_result FROM feishu_write_operations WHERE key_hash = ? AND user_id = ?").bind(key, user).first<{ payload_hash: string; status: string; encrypted_result: string | null }>();
    if (!previous || previous.payload_hash !== payloadHash) throw new AppError("request_conflict", "同一请求标识对应的写入内容不同，请为新的操作使用新的请求标识。", 409);
    if (previous.status === "succeeded" && previous.encrypted_result) return { ...(await unseal<Arguments>(previous.encrypted_result, env.TOKEN_ENCRYPTION_KEY, user)), replayed: true };
    if (previous.status === "failed" && previous.encrypted_result) {
      const failure = await unseal<{ kind: string; message: string; status: number; details?: Record<string, unknown> }>(previous.encrypted_result, env.TOKEN_ENCRYPTION_KEY, user);
      throw new AppError(failure.kind, failure.message, failure.status, failure.details);
    }
    throw new AppError("write_status_unknown", "此操作正在处理或结果尚未确认。请先检查目标资源状态，避免重复创建或写入。", 409);
  }
  try {
    // A disconnect or replacement while waiting for the claim must be noticed
    // before starting a provider operation.
    const currentToken = await accessToken(env, user, scopes);
    const result = await action(currentToken);
    const receipt = { ...(result && typeof result === "object" ? result : { result }), replayed: false };
    await env.DB.prepare("UPDATE feishu_write_operations SET status = 'succeeded', encrypted_result = ? WHERE key_hash = ? AND user_id = ? AND claim = ?").bind(await seal(receipt, env.TOKEN_ENCRYPTION_KEY, user), key, user, claim).run();
    return receipt;
  } catch (error) {
    const known = error instanceof AppError && ["feishu_api_error", "api_quota_exhausted", "revision_conflict", "invalid_input", "connection_required", "additional_authorization_required", "connection_changed", "watch_busy", "comment_not_found", "comment_reply_not_supported", "comment_already_solved", "resource_precheck_failed", "resource_deleted"].includes(error.kind);
    await env.DB.prepare("UPDATE feishu_write_operations SET status = ?, encrypted_result = ? WHERE key_hash = ? AND user_id = ? AND claim = ?").bind(known ? "failed" : "unknown", known ? await seal({ kind: error.kind, message: error.message, status: error.status, details: error.details }, env.TOKEN_ENCRYPTION_KEY, user) : null, key, user, claim).run();
    if (known) throw error;
    throw new AppError("write_status_unknown", "写入结果暂未确认，请先查看目标资源后再决定是否重试。", 503);
  }
}
