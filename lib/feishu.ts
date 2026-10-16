import { AppError, CHAT_SCOPES, DOCUMENT_SCOPES, SCOPES } from "./core";
import { randomString, seal, sha256, unseal } from "./crypto";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { EXTRA_FEATURES, missingScopes, selectedScopes } from "./features";

export type Runtime = { DB?: D1Database; FEISHU_APP_ID?: string; FEISHU_APP_SECRET?: string; SITE_ORIGIN?: string; TOKEN_ENCRYPTION_KEY?: string };
type Tokens = { access_token: string; refresh_token?: string; refresh_expires_at?: number };
type AuthorizationContext = { flow: "client_secret"; client_id: string; redirect_uri: string; scopes?: string };
type Connection = { user_id: string; encrypted_tokens: string; expires_at: number; name: string; open_id: string; scope: string; refresh_lock: string | null; lock_expires_at: number | null; updated_at: number };
const now = () => Math.floor(Date.now() / 1000);
const REFRESH_EARLY_SECONDS = 120;
const REFRESH_LEASE_SECONDS = 30;
// Cover the 15s provider timeout and an abandoned 30s lease, with a small margin.
const REFRESH_WAIT_MS = 35000;
const REFRESH_WORK_MS = REFRESH_WAIT_MS + 15000 + 5000;
const REFRESH_FAILURE_COOLDOWN_SECONDS = 3;
// Only in-flight work is shared. Never cache an account's tokens or permissions.
type RefreshFlight = { promise: Promise<void>; expiresAt: number };
const refreshPools = new WeakMap<D1Database, { flights: Map<string, RefreshFlight>; sweepAt: number }>();
// Current Feishu OAuth token endpoint. Authorization is initiated through the documented authorize endpoint.
const TOKEN_ENDPOINT = "https://accounts.feishu.cn/oauth/v3/token";

export function configuration(e: Runtime) {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "SITE_ORIGIN", "TOKEN_ENCRYPTION_KEY"].filter(k => !e[k as keyof Runtime]);
  if (e.TOKEN_ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(e.TOKEN_ENCRYPTION_KEY)) missing.push("TOKEN_ENCRYPTION_KEY_FORMAT");
  if (!e.DB) missing.push("DB");
  return { configured: missing.length === 0, missing, origin: e.SITE_ORIGIN || "", app_id: e.FEISHU_APP_ID || "", callback_url: e.SITE_ORIGIN ? `${e.SITE_ORIGIN}/auth/feishu/callback` : "", scopes: SCOPES };
}

function ready(e: Runtime) {
  if (!configuration(e).configured) throw new AppError("configuration_required", "请先在连接页面完成应用配置，并应用新的托管环境设置。", 503);
  return e as Runtime & { DB: D1Database; FEISHU_APP_ID: string; FEISHU_APP_SECRET: string; SITE_ORIGIN: string; TOKEN_ENCRYPTION_KEY: string };
}

export async function status(e: Runtime, user: string | null) {
  const cfg = configuration(e);
  if (!user) return { ...cfg, connected: false, needs_chatgpt_signin: true, connection_url: cfg.origin };
  if (!cfg.configured) return { ...cfg, connected: false, connection_url: cfg.origin };
  const row = await e.DB!.prepare("SELECT name, scope, expires_at FROM feishu_connections WHERE user_id = ?").bind(user).first<{ name: string; scope: string; expires_at: number }>();
  const granted = row?.scope.split(" ").filter(Boolean) || [];
  const missingChat = CHAT_SCOPES.filter(scope => !granted.includes(scope));
  const features = EXTRA_FEATURES.map(feature => ({ ...feature, scopes: [...feature.scopes], ready: !!row && missingScopes(granted, feature.scopes).length === 0, missing_scopes: missingScopes(granted, feature.scopes) }));
  return { ...cfg, connected: !!row, account_name: row?.name || null, granted_scopes: granted,
    base_scopes: SCOPES, available_feature_scopes: [...new Set(EXTRA_FEATURES.flatMap(feature => [...feature.scopes]))],
    scope_note: "scopes 与 base_scopes 仅表示基础权限，不是上一次授权请求的全部权限；granted_scopes 是最近保存的用户授权，功能权限另见 features。",
    permission_check: { source: "stored_user_grant", live_api_verified: false, resource_access_verified: false },
    missing_feature_scopes: [...new Set(features.flatMap(feature => feature.missing_scopes))],
    messaging_ready: !!row && missingChat.length === 0, missing_chat_scopes: missingChat, features, access_token_expires_at: row?.expires_at || null, connection_url: cfg.origin };
}

async function tokenRequest(e: Runtime, values: Record<string, string>) {
  const cfg = ready(e);
  const response = await fetch(TOKEN_ENDPOINT, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg.FEISHU_APP_ID, client_secret: cfg.FEISHU_APP_SECRET, ...values }), signal: AbortSignal.timeout(15000) });
  if (response.status >= 300 && response.status < 400) throw new AppError("provider_redirect", "飞书接口发生跳转，连接已中止，请联系创建此服务的助手检查。", 502);
  const body = await response.json() as { code?: number; access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string };
  if (!response.ok || (body.code !== undefined && Number(body.code) !== 0) || !body.access_token || !body.expires_in) {
    const permanent = [20002, 20024, 20026, 20037, 20064, 20073, 20074].includes(Number(body.code)) || body.error === "invalid_grant";
    throw new AppError(permanent ? "reauthorization_required" : "oauth_error", `飞书授权未成功${body.code ? `（错误码 ${Number(body.code)}）` : ""}。请检查应用密钥、重定向地址和权限，然后重新连接。`, 400);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in, refresh_expires_at: body.refresh_token_expires_in ? now() + body.refresh_token_expires_in : undefined, scope: body.scope || values.scope || DOCUMENT_SCOPES.join(" ") };
}

export async function startAuthorization(e: Runtime, user: string, features: string[] = []) {
  const cfg = ready(e);
  const state = randomString();
  // This hosted application is a Confidential Client. Feishu documents the
  // v1 authorize + v3 token pair with client_secret; the v1 entrypoint's PKCE
  // support is documented for the v2 token endpoint only.
  const context: AuthorizationContext = { flow: "client_secret", client_id: cfg.FEISHU_APP_ID, redirect_uri: `${cfg.SITE_ORIGIN}/auth/feishu/callback`, scopes: selectedScopes(SCOPES, features).join(" ") };
  // Keep the existing database column, storing encrypted request context.
  await cfg.DB.batch([
    cfg.DB.prepare("DELETE FROM feishu_oauth_states WHERE expires_at < ? OR user_id = ?").bind(now(), user),
    cfg.DB.prepare("INSERT INTO feishu_oauth_states (state_hash, user_id, encrypted_verifier, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(state), user, await seal(context, cfg.TOKEN_ENCRYPTION_KEY, user), now() + 300),
  ]);
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.search = new URLSearchParams({ client_id: cfg.FEISHU_APP_ID, response_type: "code", redirect_uri: context.redirect_uri, scope: context.scopes!, state, prompt: "consent" }).toString();
  return url.toString();
}

export async function finishAuthorization(e: Runtime, user: string, code: string | null, state: string | null, denied: boolean) {
  const cfg = ready(e);
  if (!state || state.length > 200) throw new AppError("invalid_state", "授权状态不匹配，请返回连接页面重新开始。");
  const row = await cfg.DB.prepare("DELETE FROM feishu_oauth_states WHERE state_hash = ? AND user_id = ? AND expires_at >= ? RETURNING encrypted_verifier").bind(await sha256(state), user, now()).first<{ encrypted_verifier: string }>();
  if (!row) throw new AppError("invalid_state", "授权链接已过期或已使用，请重新连接。");
  if (denied) throw new AppError("access_denied", "你已取消飞书授权。");
  if (!code || code.length > 1024) throw new AppError("invalid_code", "没有收到飞书授权码，请重新连接。");
  const context = await unseal<AuthorizationContext | null>(row.encrypted_verifier, cfg.TOKEN_ENCRYPTION_KEY, user);
  if (!context || context.flow !== "client_secret" || context.client_id !== cfg.FEISHU_APP_ID || context.redirect_uri !== `${cfg.SITE_ORIGIN}/auth/feishu/callback`) throw new AppError("invalid_state", "授权配置已更新，请返回连接页面重新开始。");
  // Keep in-flight document-only grants usable across deployment.
  const scope = context.scopes || DOCUMENT_SCOPES.join(" ");
  const tokens = await tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: context.redirect_uri, scope });
  if (!tokens.refresh_token) throw new AppError("missing_offline_access", "飞书未授予离线访问权限。请开通 offline_access 后重新连接。");
  const info = await apiWithToken(tokens.access_token, "/authen/v1/user_info") as { name?: string; open_id?: string };
  if (!info.open_id) throw new AppError("identity_failed", "飞书账号验证失败，请重新连接。");
  await cfg.DB.prepare("INSERT INTO feishu_connections (user_id, encrypted_tokens, expires_at, name, open_id, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens, expires_at=excluded.expires_at, name=excluded.name, open_id=excluded.open_id, scope=excluded.scope, refresh_lock=NULL, lock_expires_at=NULL, updated_at=excluded.updated_at").bind(user, await seal({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, refresh_expires_at: tokens.refresh_expires_at }, cfg.TOKEN_ENCRYPTION_KEY, user), now() + tokens.expires_in, info.name || "飞书用户", info.open_id, tokens.scope, now()).run();
}

export async function disconnect(e: Runtime, user: string) {
  if (!e.DB) return;
  await e.DB.batch([
    e.DB.prepare("DELETE FROM feishu_connections WHERE user_id = ?").bind(user),
    e.DB.prepare("DELETE FROM feishu_oauth_states WHERE user_id = ?").bind(user),
    e.DB.prepare("DELETE FROM feishu_client_keys WHERE user_id = ?").bind(user),
    e.DB.prepare("DELETE FROM feishu_mcp_oauth_requests WHERE user_id = ?").bind(user),
    e.DB.prepare("DELETE FROM feishu_mcp_oauth_codes WHERE user_id = ?").bind(user),
    e.DB.prepare("UPDATE feishu_mcp_oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now(), user),
  ]);
}

function requireScopes(scope: string, required: string[]) {
  const granted = scope.split(" ");
  const missing = missingScopes(granted, required);
  if (missing.length) throw new AppError("additional_authorization_required", `此功能缺少用户授权：${missing.join("、")}。请先在飞书开发者后台开通对应用户身份权限，再在连接页面选择功能并更新授权范围。`, 403, { missing_scopes: missing, permission_layer: "user", reauthorization_required: true });
}

export async function accessToken(e: Runtime, user: string, required: string[] = []): Promise<string> {
  const cfg = ready(e);
  let row = await connection(cfg, user);
  requireScopes(row.scope, required);
  if (row.expires_at > now() + REFRESH_EARLY_SECONDS) return (await unseal<Tokens>(row.encrypted_tokens, cfg.TOKEN_ENCRYPTION_KEY, user)).access_token;

  let pool = refreshPools.get(cfg.DB);
  if (!pool) { pool = { flights: new Map(), sweepAt: 0 }; refreshPools.set(cfg.DB, pool); }
  const flights = pool.flights;
  if (pool.sweepAt <= Date.now()) {
    for (const [account, pending] of flights) if (pending.expiresAt <= Date.now()) flights.delete(account);
    pool.sweepAt = Date.now() + REFRESH_WORK_MS;
  }
  let flight = flights.get(user);
  if (flight && flight.expiresAt <= Date.now()) { flights.delete(user); flight = undefined; }
  if (!flight) {
    flight = { promise: refreshConnection(cfg, user), expiresAt: Date.now() + REFRESH_WORK_MS };
    flights.set(user, flight);
    const cleanup = () => { if (flights.get(user) === flight) flights.delete(user); };
    // Both handlers remove the entry; no rejected Promise is left unhandled.
    void flight.promise.then(cleanup, cleanup);
    // Keep the coordinator alive if its initiating client disconnects. Only a
    // void result is shared, never a response body/stream owned by that request.
    getRequestExecutionContext()?.waitUntil(flight.promise.then(() => {}, () => {}));
  }
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([flight.promise, new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        if (flights.get(user) === flight) flights.delete(user);
        reject(new AppError("refresh_in_progress", "飞书连接正在续期，请稍后重试。", 503, { retry_after_seconds: 2 }));
      }, Math.max(0, flight.expiresAt - Date.now()));
    })]);
  } finally { if (watchdog !== undefined) clearTimeout(watchdog); }
  // Recheck per caller: a grant can be revoked, replaced or lose scopes while
  // refreshing. Sharing a Promise must not share the first caller's permissions.
  row = await connection(cfg, user);
  requireScopes(row.scope, required);
  if (row.expires_at <= now()) throw new AppError("connection_changed", "飞书连接已更新，请重试。", 409);
  return (await unseal<Tokens>(row.encrypted_tokens, cfg.TOKEN_ENCRYPTION_KEY, user)).access_token;
}

async function connection(cfg: ReturnType<typeof ready>, user: string): Promise<Connection> {
  const row = await cfg.DB.prepare("SELECT * FROM feishu_connections WHERE user_id = ?").bind(user).first<Connection>();
  if (!row) throw new AppError("connection_required", `请打开 ${cfg.SITE_ORIGIN} 连接你的飞书账号。`, 401);
  return row;
}

async function refreshConnection(cfg: ReturnType<typeof ready>, user: string): Promise<void> {
  // Raw D1 queries go to the primary, so another isolate's writes are visible.
  let row = await connection(cfg, user);
  const lock = randomString(18);
  const waitDeadline = Date.now() + REFRESH_WAIT_MS;
  let delay = 100;
  while (true) {
    if (row.expires_at > now() + REFRESH_EARLY_SECONDS) return;
    if (row.refresh_lock === null || row.lock_expires_at === null || row.lock_expires_at <= now()) {
      const acquired = await cfg.DB.prepare("UPDATE feishu_connections SET refresh_lock = ?, lock_expires_at = ? WHERE user_id = ? AND (refresh_lock IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?) RETURNING user_id").bind(lock, now() + REFRESH_LEASE_SECONDS, user, now()).first();
      if (acquired) break;
    }
    const remaining = waitDeadline - Date.now();
    if (remaining <= 0) throw new AppError("refresh_in_progress", "飞书连接正在续期，请稍后重试。", 503, { retry_after_seconds: 2 });
    // Only one poller per account per isolate; jitter keeps different isolates
    // from querying/competing in lockstep. The SQL remains the final fence.
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.round(delay * (0.75 + Math.random() * 0.5)), remaining)));
    delay = Math.min(delay * 2, 1500);
    row = await connection(cfg, user);
  }
  let release = true;
  try {
    // Reread after acquiring the cross-isolate lock: another request may already have rotated the token.
    row = await connection(cfg, user);
    if (row.expires_at > now() + REFRESH_EARLY_SECONDS) return;
    if (row.refresh_lock !== lock) throw new AppError("connection_changed", "飞书连接已更新，请重试。", 409);
    const tokens = await unseal<Tokens>(row.encrypted_tokens, cfg.TOKEN_ENCRYPTION_KEY, user);
    if (!tokens.refresh_token || (tokens.refresh_expires_at && tokens.refresh_expires_at <= now())) throw new AppError("reauthorization_required", `飞书授权已过期，请打开 ${cfg.SITE_ORIGIN} 重新连接。`, 401);
    const renewed = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: row.scope });
    if (!renewed.refresh_token) throw new AppError("reauthorization_required", "飞书未返回续期令牌，请重新连接。", 401);
    const saved = await cfg.DB.prepare("UPDATE feishu_connections SET encrypted_tokens = ?, expires_at = ?, scope = ?, updated_at = ? WHERE user_id = ? AND refresh_lock = ?").bind(await seal({ access_token: renewed.access_token, refresh_token: renewed.refresh_token, refresh_expires_at: renewed.refresh_expires_at }, cfg.TOKEN_ENCRYPTION_KEY, user), now() + renewed.expires_in, renewed.scope, now(), user, lock).run();
    if (saved.meta.changes !== 1) {
      await connection(cfg, user);
      throw new AppError("connection_changed", "飞书连接已更新，请重试。", 409);
    }
  } catch (error) {
    if (error instanceof AppError && error.kind === "reauthorization_required") await cfg.DB.prepare("DELETE FROM feishu_connections WHERE user_id = ? AND refresh_lock = ?").bind(user, lock).run();
    else {
      // Briefly keep the lease after failure, rather than letting many isolates
      // immediately retry the provider. The next coordinator can recover it.
      const cooling = await cfg.DB.prepare("UPDATE feishu_connections SET lock_expires_at = ? WHERE user_id = ? AND refresh_lock = ?").bind(now() + REFRESH_FAILURE_COOLDOWN_SECONDS, user, lock).run();
      release = cooling.meta.changes !== 1;
    }
    throw error;
  } finally {
    if (release) await cfg.DB.prepare("UPDATE feishu_connections SET refresh_lock = NULL, lock_expires_at = NULL WHERE user_id = ? AND refresh_lock = ?").bind(user, lock).run();
  }
}

export async function apiResponse(token: string, path: string, body?: unknown, method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) throw new AppError("invalid_input", "接口路径无效。");
  return fetch(`https://open.feishu.cn/open-apis${path}`, { method: method || (body === undefined ? "GET" : "POST"), redirect: "manual", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
}

function providerMessage(value: unknown, credentials: string[]) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Only the diagnostic msg is returned, never the provider's request/body.
  // Remove known credentials before bounding the text so truncation cannot
  // leave the prefix of an echoed access token behind.
  let message = value;
  for (const credential of credentials) if (credential) message = message.split(credential).join("[凭据已隐藏]");
  message = message.slice(0, 8192)
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[链接已省略]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, "[凭据已隐藏]")
    .replace(/\b((?:(?:tenant|user|app)_)?access_token|refresh_token|id_token|client_secret|app_secret|authorization|api[-_ ]?key|password|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1=[凭据已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[凭据已隐藏]")
    .replace(/\b[ut]-[A-Za-z0-9_-]{8,}/g, "[凭据已隐藏]")
    .replace(/\s+/g, " ").trim();
  return message.length > 1000 ? message.slice(0, 1000) + "…" : message || undefined;
}

export function providerError(response: Response, payload: { code?: number; msg?: unknown; error?: { log_id?: unknown; permission_violations?: unknown } }, path?: string, credentials: string[] = []): never {
  const code = Number(payload.code);
  const scopeError = code === 99991679 || code === 99991672;
  // Keep the provider's actionable permission details, not arbitrary upstream
  // response fields which can contain tokens, request bodies or personal data.
  const violations = scopeError && Array.isArray(payload.error?.permission_violations) ? payload.error.permission_violations.slice(0, 50) : [];
  const requiredScopes = [...new Set(violations.map(item => item && typeof item === "object" ? (item as Record<string, unknown>).subject : null).filter((scope): scope is string => typeof scope === "string" && /^[a-z][a-z0-9_.]*:[a-z0-9_.:]{1,150}$/.test(scope)))];
  const permissionHint = requiredScopes.length ? ` 飞书返回的所需权限选项：${requiredScopes.join("、")}。` : "";
  // Numeric codes can be reused by unrelated products. Only classify cloud
  // document errors on their documented API families; never infer deletion
  // from a generic 403/404 or from the provider's arbitrary message string.
  const apiPath = path?.split("?")[0];
  const cloudDocument = /^\/(?:docx\/v1|drive\/v1|bitable\/v1|sheets\/v[23])\//.test(apiPath || "");
  const spreadsheet = /^\/sheets\/v[23]\//.test(apiPath || "");
  const fileDownloadMissing = response.status === 404 && !Number.isFinite(code) && /^\/drive\/v1\/files\/[^/]+\/download$/.test(apiPath || "");
  const deleted = (cloudDocument && [1002, 1770003, 1069304].includes(code)) || (spreadsheet && code === 1310249);
  const notFound = (cloudDocument && [1770002, 1069305, 1069307].includes(code)) || (spreadsheet && code === 1310214) || fileDownloadMissing;
  const resourceMessage = deleted ? `目标文档或内容已删除，无法继续读取或操作（飞书错误码 ${code}）。` : fileDownloadMissing ? "文件下载接口未找到该文件（HTTP 404）。文件 token 可能不存在，或文件已被删除；仅凭此响应不能区分这两种情况。" : notFound ? `未找到目标文档、评论或内容（飞书错误码 ${code}）。请核对目标 ID 和访问权限；仅凭此错误不能确认已删除。` : cloudDocument && code === 1069301 ? "飞书评论接口内部处理失败（错误码 1069301），请稍后复查；此错误不能确认评论是否已删除。" : null;
  const message = resourceMessage ?? (code === 99991403 ? "飞书组织当月 API 调用额度已用完。请在飞书管理后台查看「我的配额」。" : code === 99991400 || response.status === 429 ? "飞书接口调用过于频繁，请稍后重试。" : code === 99992402 ? "请求参数不符合飞书接口要求，请检查分页数量、时间范围及其他参数。" : code === 99991679 ? "当前飞书用户令牌缺少此接口要求的用户授权。请确认应用已开通对应用户身份权限，再更新飞书授权范围；仅刷新旧令牌不能增加权限。" + permissionHint : code === 99991672 ? "飞书应用尚未开通此接口所需权限。请在开发者后台开通并发布；仅重新登录不能替代应用权限开通。" + permissionHint : [99991663, 99991668, 230027, 1770032].includes(code) || response.status === 403 ? "飞书权限不足。请检查应用权限、用户授权及目标资源的访问权限。" : [232025, 230006].includes(code) ? "飞书应用未启用机器人能力，请在开发者后台启用并发布。" : [232011, 230002, 230073].includes(code) ? "当前身份无法访问该群聊或话题，请确认访问范围。" : `飞书接口未成功（错误码 ${Number.isFinite(code) ? code : response.status}）。请结合飞书原始说明、接口路径和追踪 ID 排查。`);
  const requestId=response.headers.get("x-tt-logid") || payload.error?.log_id;
  const diagnostic = providerMessage(payload.msg, credentials);
  throw new AppError(code === 99991403 ? "api_quota_exhausted" : "feishu_api_error", message, code === 99991403 ? 429 : response.status >= 400 ? response.status : 400, { provider_code: Number.isFinite(code) ? code : null, provider_http_status: response.status, ...(diagnostic ? { provider_message: diagnostic } : {}), ...(apiPath ? {provider_path:apiPath} : {}), ...(typeof requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? {provider_request_id:requestId} : {}), ...(deleted ? { resource_state: "deleted", retryable: false } : notFound ? { resource_state: "not_found" } : {}), ...(scopeError ? { permission_layer: code === 99991679 ? "user" : "app", reauthorization_required: code === 99991679, provider_required_scopes: requiredScopes, provider_permission_violations: requiredScopes.map(subject => ({ subject })) } : {}) });
}

export async function apiWithToken(token: string, path: string, body?: unknown, method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"): Promise<unknown> {
  const response = await apiResponse(token, path, body, method);
  if (response.status >= 300 && response.status < 400) throw new AppError("provider_redirect", "飞书接口发生跳转，连接已中止，请联系创建此服务的助手检查。", 502);
  const payload = await response.json() as { code?: number; data?: unknown };
  if (!response.ok || Number(payload.code) !== 0) {
    providerError(response, payload, path, [token]);
  }
  return payload.data;
}
