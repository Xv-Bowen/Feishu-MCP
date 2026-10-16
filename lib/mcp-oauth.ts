import { AppError } from "./core";
import { randomString, sha256 } from "./crypto";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, MCP_SCOPES, type McpClientAccess } from "./client-permissions";

// Browser identity continues to come from Sites. These grants authorize the
// external MCP client; they never contain or expose Feishu access tokens.
export type OAuthContext = { DB?: D1Database; SITE_ORIGIN?: string; SITE_SERVICE_ACCESS?: string; CLIENT_OAUTH_ORIGIN?: string; CLIENT_MCP_PUBLIC?: string; MCP_OAUTH_CLIENT_ID?: string };
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const CALLBACKS = [CALLBACK, CHATGPT_CALLBACK];
const CHATGPT_CLIENT_METADATA = "https://chatgpt.com/oauth/client.json";
const CLAUDE_CLIENT_METADATA = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLIENT_METHODS = ["client_id_metadata_document", "dynamic_registration", "manual"];
const callbackName = (callback: string) => callback === CALLBACK ? "Claude" : "ChatGPT";
function officialCallback(value: string): boolean {
  return CALLBACKS.includes(value) || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(value);
}
export const publicClientMcp = (env: OAuthContext) => env.CLIENT_MCP_PUBLIC === "true";
const READ_SCOPE = MCP_READ_SCOPE;
const ACCESS_LIFETIME = 3600;
const REFRESH_LIFETIME = 30 * 86400;
const GRANT_LIFETIME = 90 * 86400;
const now = () => Math.floor(Date.now() / 1000);
const noStore = { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer" };

class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function database(env: OAuthContext): D1Database {
  if (!env.DB) throw new OAuthError("temporarily_unavailable", "授权存储暂时不可用。", 503);
  return env.DB;
}
function origin(env: OAuthContext): string {
  if (!env.SITE_ORIGIN) throw new OAuthError("temporarily_unavailable", "授权地址尚未配置。", 503);
  return new URL(env.SITE_ORIGIN).origin;
}
function clientOrigin(env: OAuthContext): string {
  if (!env.CLIENT_OAUTH_ORIGIN) return origin(env);
  const url = new URL(env.CLIENT_OAUTH_ORIGIN);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new OAuthError("temporarily_unavailable", "网关地址配置不正确。", 503);
  return url.origin;
}
// Sites reserves /mcp for its platform-authenticated plugin transport even on
// public Sites. Both manually configured external hosts use this shared URL.
export const oauthResource = (env: OAuthContext) => `${clientOrigin(env)}/api/client-mcp`;
const issuer = (env: OAuthContext) => `${clientOrigin(env)}/api/claude-oauth`;
function json(data: unknown, status = 200): Response { return Response.json(data, { status, headers: noStore }); }
function escape(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function html(title: string, body: string, status = 200): Response {
  // no-referrer turns Origin into null on ordinary form POSTs. same-origin
  // preserves the form's origin without sending a referrer back to Claude.
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · 飞书</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#f5f7fb;color:#19212d;margin:0;padding:24px}main{max-width:540px;margin:6vh auto;background:white;padding:32px;border-radius:20px;box-shadow:0 12px 50px #162d4710}h1{font-size:26px;line-height:1.4}small{color:#5b6472}button,a.button{font:inherit;border:0;border-radius:10px;padding:12px 20px;cursor:pointer;background:#2468e8;color:white;text-decoration:none;display:inline-block}button.secondary{background:#edf1f7;color:#19212d;margin-left:8px}.account{background:#f4f7fb;padding:12px 16px;border-radius:10px;overflow-wrap:anywhere}a{color:#2468e8}form{margin-top:24px}</style></head><body><main>${body}</main></body></html>`, { status, headers: { ...noStore, "Referrer-Policy": "same-origin", "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'", "X-Content-Type-Options": "nosniff" } });
}
function failure(error: unknown, browser = false): Response {
  const known = error instanceof OAuthError;
  const code = known ? error.code : "server_error";
  const message = known ? error.message : "授权服务暂时不可用，请重新连接。";
  const status = known ? error.status : 500;
  return browser ? html("授权未完成", `<h1>授权未完成</h1><p>${escape(message)}</p><p>请返回 AI 客户端重新开始连接。</p>`, status) : json({ error: code, error_description: message }, status);
}
function parameter(params: URLSearchParams, key: string, maximum = 2048): string {
  if (params.getAll(key).length > 1) throw new OAuthError("invalid_request", `重复的 ${key} 参数。`);
  const value = params.get(key) || "";
  if (value.length > maximum) throw new OAuthError("invalid_request", `${key} 参数过长。`);
  return value;
}
function resourceParameter(env: OAuthContext, value: string): string {
  if (value !== oauthResource(env)) throw new OAuthError("invalid_target", "授权仅可用于本服务的客户端 MCP 地址。");
  return value;
}
function scopes(value: string): string {
  // New connections support the full tool set after the user explicitly
  // approves the read/write consent page. An explicitly requested read-only
  // scope and all existing grants keep their original scope.
  const requested = [...new Set((value || MCP_SCOPES.join(" ")).split(/\s+/).filter(Boolean))];
  if (!requested.includes(READ_SCOPE) || requested.some(scope => !MCP_SCOPES.includes(scope))) throw new OAuthError("invalid_scope", "请使用 feishu.read、可选 feishu.write 和 offline_access 授权范围。");
  return [READ_SCOPE, ...(requested.includes(MCP_WRITE_SCOPE) ? [MCP_WRITE_SCOPE] : []), ...(requested.includes("offline_access") ? ["offline_access"] : [])].join(" ");
}
async function form(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new OAuthError("invalid_request", "请使用表单编码提交授权请求。", 415);
  const body = await request.text();
  if (body.length > 16384) throw new OAuthError("invalid_request", "授权请求过长。", 413);
  return new URLSearchParams(body);
}
function requireBrowserUser(env: OAuthContext, request: Request, mutation = false): string {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || (mutation && request.headers.get("origin") !== origin(env))) throw new OAuthError("access_denied", "请使用已登录的连接页面操作。", 403);
  return user;
}
function requireConsentUser(env: OAuthContext, request: Request): string {
  const user = requireBrowserUser(env, request);
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin === origin(env)) return user;
  const url = new URL(request.url);
  // Older consent pages and privacy-focused app browsers can send an opaque
  // Origin. Only same-origin document navigations may use this fallback; the
  // approval still requires a one-use CSRF token bound to this verified user.
  const sameOriginForm = request.method === "POST" && url.origin === origin(env)
    && url.pathname === "/api/claude-oauth/authorize"
    && request.headers.get("sec-fetch-site") === "same-origin"
    && request.headers.get("sec-fetch-mode") === "navigate"
    && request.headers.get("sec-fetch-dest") === "document";
  if ((requestOrigin !== null && requestOrigin !== "null") || !sameOriginForm) throw new OAuthError("access_denied", "请使用已登录的连接页面操作。", 403);
  return user;
}
async function connected(env: OAuthContext, user: string): Promise<boolean> {
  return !!await database(env).prepare("SELECT user_id FROM feishu_connections WHERE user_id = ?").bind(user).first();
}

async function validateClient(env: OAuthContext, clientId: string, redirectUri: string): Promise<void> {
  if (!officialCallback(redirectUri)) throw new OAuthError("invalid_client", "客户端或回调地址未注册。");
  // Keep the owner's existing manual client intact. Automatic registration is
  // an additional choice, not a replacement for previously issued grants.
  if (env.MCP_OAUTH_CLIENT_ID && clientId === env.MCP_OAUTH_CLIENT_ID) return;

  const documentMatch = /^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{1,128})\/client\.json$/.exec(clientId);
  const metadataCallback = clientId === CLAUDE_CLIENT_METADATA ? CALLBACK
    : clientId === CHATGPT_CLIENT_METADATA ? CHATGPT_CALLBACK
    : documentMatch ? `https://chatgpt.com/connector/oauth/${documentMatch[1]}` : null;
  if (metadataCallback) {
    if (redirectUri !== metadataCallback) throw new OAuthError("invalid_client", "客户端元数据与回调地址不匹配。");
    const clientName = clientId === CLAUDE_CLIENT_METADATA ? "Claude" : "ChatGPT";
    // Fetch only these exact official HTTPS document paths. Never forward Site
    // headers, follow redirects or fetch an arbitrary client-supplied URL.
    let response: Response;
    try { response = await fetch(clientId, { headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(6000) }); }
    catch { throw new OAuthError("temporarily_unavailable", `${clientName} 官方身份服务暂时不可用。请返回客户端，选择「自动注册」后重新连接；无需填写客户端 ID 或密钥。`, 503); }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new OAuthError("temporarily_unavailable", `${clientName} 官方身份服务暂时无法读取。请返回客户端，选择「自动注册」后重新连接；无需填写客户端 ID 或密钥。`, 503);
    }
    if (!response.ok || (mime !== "application/json" && !mime?.endsWith("+json"))) {
      await response.body?.cancel();
      throw new OAuthError("invalid_client_metadata", "官方客户端信息不可用或格式不正确。");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new OAuthError("invalid_client_metadata", "缺少官方客户端信息。");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 32768) { await reader.cancel(); throw new OAuthError("invalid_client_metadata", "客户端信息过长。"); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("temporarily_unavailable", "读取客户端信息失败，请稍后重试。", 503);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(new TextDecoder().decode(bytes)); if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") throw new Error(); }
    catch { throw new OAuthError("invalid_client_metadata", "客户端信息不是有效的 JSON 对象。"); }
    if (metadata.client_id !== clientId || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length > 64
      || metadata.redirect_uris.some(uri => typeof uri !== "string" || uri.length > 2048) || !metadata.redirect_uris.includes(redirectUri)) throw new OAuthError("invalid_client_metadata", "客户端标识或回调地址与官方信息不匹配。");
    // Current ChatGPT metadata advertises an array of supported methods, with
    // a legacy singular preference. Select the supported intersection (none),
    // rather than rejecting the legacy private_key_jwt preference.
    const methods = metadata.token_endpoint_auth_methods_supported ?? [metadata.token_endpoint_auth_method || "client_secret_basic"];
    if (!Array.isArray(methods) || methods.some(method => typeof method !== "string") || !methods.includes("none")) throw new OAuthError("invalid_client_metadata", "客户端未提供本服务支持的公共客户端验证方式。");
    return;
  }
  const client = await database(env).prepare("SELECT redirect_uri FROM feishu_mcp_oauth_clients WHERE client_id = ?").bind(clientId).first<{ redirect_uri: string }>();
  if (!client || redirectUri !== client.redirect_uri) throw new OAuthError("invalid_client", "客户端或回调地址未注册。");
}

export function authorizationServerMetadata(env: OAuthContext): Response {
  try {
    const base = issuer(env);
    return json({ issuer: base, authorization_endpoint: `${origin(env)}/api/claude-oauth/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, client_id_metadata_document_supported: true, scopes_supported: MCP_SCOPES, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true });
  } catch (error) { return failure(error); }
}
export function protectedResourceMetadata(env: OAuthContext): Response {
  try { return json({ resource: oauthResource(env), resource_name: "飞书", authorization_servers: [issuer(env)], scopes_supported: MCP_SCOPES, bearer_methods_supported: ["header"] }); }
  catch (error) { return failure(error); }
}
export function oauthChallenge(env: OAuthContext, invalid = false): Response {
  return Response.json({ error: invalid ? "invalid_token" : "authorization_required", message: "请通过 OAuth 授权，或使用连接页面生成的客户端凭据。" }, { status: 401, headers: { ...noStore, "WWW-Authenticate": oauthBearerChallenge(env, invalid ? "invalid_token" : undefined) } });
}

export function oauthBearerChallenge(env: OAuthContext, error?: "invalid_token" | "insufficient_scope") {
  const scope = error === "insufficient_scope" ? `${READ_SCOPE} ${MCP_WRITE_SCOPE}` : MCP_SCOPES.join(" ");
  return `Bearer resource_metadata="${issuer(env)}/resource", scope="${scope}"${error ? `, error="${error}", error_description="${error === "insufficient_scope" ? "Approve feishu.write to edit your authorized resources" : "Reconnect to this MCP server"}"` : ""}`;
}

async function register(env: OAuthContext, request: Request): Promise<Response> {
  if (request.headers.has("origin") && request.headers.get("origin") !== origin(env)) throw new OAuthError("invalid_client_metadata", "不接受跨站客户端注册。", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new OAuthError("invalid_client_metadata", "客户端注册需要 JSON。", 415);
  const text = await request.text();
  if (text.length > 8192) throw new OAuthError("invalid_client_metadata", "客户端注册请求过长。", 413);
  let input: Record<string, unknown>;
  try { input = JSON.parse(text); if (!input || Array.isArray(input) || typeof input !== "object") throw new Error(); }
  catch { throw new OAuthError("invalid_client_metadata", "无效的客户端注册请求。"); }
  // No untrusted callback URL or client metadata URL is fetched or followed.
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length !== 1 || typeof input.redirect_uris[0] !== "string" || !officialCallback(input.redirect_uris[0])) throw new OAuthError("invalid_redirect_uri", "此入口仅允许 ChatGPT 或 Claude 官方托管客户端的回调地址。");
  const redirectUri = input.redirect_uris[0];
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") throw new OAuthError("invalid_client_metadata", "请注册使用 PKCE 的公共客户端。");
  for (const [key, allowed] of [["grant_types", ["authorization_code", "refresh_token"]], ["response_types", ["code"]]] as const) {
    const value = input[key];
    if (value !== undefined && (!Array.isArray(value) || !value.length || value.some(item => !allowed.some(option => option === item)))) throw new OAuthError("invalid_client_metadata", "不支持此客户端授权类型。");
  }
  const db = database(env);
  const count = await db.prepare("SELECT COUNT(*) AS total FROM feishu_mcp_oauth_clients").first<{ total: number }>();
  if ((count?.total || 0) >= 500) throw new OAuthError("temporarily_unavailable", "客户端注册数量达到上限，请联系服务所有者。", 429);
  const clientId = `fsoauth_${randomString()}`;
  await db.prepare("INSERT INTO feishu_mcp_oauth_clients (client_id, redirect_uri, created_at) VALUES (?, ?, ?)").bind(clientId, redirectUri, now()).run();
  return json({ client_id: clientId, client_id_issued_at: now(), client_name: callbackName(redirectUri), redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
}

type AuthorizationRequest = { user_id: string; client_id: string; redirect_uri: string; challenge: string; state: string; resource: string; scope: string };
async function authorize(env: OAuthContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const clientId = parameter(params, "client_id");
  const redirectUri = parameter(params, "redirect_uri");
  await validateClient(env, clientId, redirectUri);
  if (parameter(params, "response_type") !== "code") throw new OAuthError("unsupported_response_type", "仅支持授权码流程。");
  const challenge = parameter(params, "code_challenge", 128);
  if (parameter(params, "code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthError("invalid_request", "需要有效的 S256 PKCE 校验。");
  const resource = resourceParameter(env, parameter(params, "resource"));
  const scope = scopes(parameter(params, "scope", 200));
  const state = parameter(params, "state");
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user) {
    const returnTo = `/api/claude-oauth/authorize${url.search}`;
    return new Response(null, { status: 303, headers: { ...noStore, Location: `/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}` } });
  }
  const clientName = callbackName(redirectUri);
  if (!await connected(env, user)) return html("先连接飞书", `<h1>先连接你的飞书账号</h1><p>请在连接页面完成飞书授权，然后返回 ${clientName} 重新连接。</p><a class="button" href="/" target="_top">打开连接页面</a>`, 403);
  const requestId = randomString();
  const csrf = randomString();
  const db = database(env);
  await db.batch([
    db.prepare("DELETE FROM feishu_mcp_oauth_requests WHERE expires_at < ?").bind(now()),
    db.prepare("DELETE FROM feishu_mcp_oauth_codes WHERE expires_at < ?").bind(now()),
    db.prepare("INSERT INTO feishu_mcp_oauth_requests (request_hash, user_id, client_id, redirect_uri, challenge, state, resource, scope, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(await sha256(requestId), user, clientId, redirectUri, challenge, state, resource, scope, await sha256(csrf), now() + 300),
  ]);
  const email = request.headers.get("oai-authenticated-user-email") || "当前已登录账号";
  const write = scope.split(" ").includes(MCP_WRITE_SCOPE);
  const edits = write ? "<li><strong>创建、编辑或删除云空间文档及内容块，删除整份电子表格、多维表格、上传文件、幻灯片或文件夹，添加、回复、解决或删除评论及回复；按明确范围删除知识库节点和子节点。</strong></li><li><strong>读写表格，新增、复制或删除工作表，调整样式，建表和批量新增多维表格记录，删除数据表或指定记录。</strong></li><li><strong>上传文件，创建文档导入或导出任务。</strong></li><li><strong>创建、修改或删除日程和重复系列，按要求邀请参会人。</strong></li><li><strong>创建、修改、分派、完成或删除任务，创建或删除任务清单。</strong></li><li><strong>建立、执行、暂停或删除群聊检查规则，记录和标记变化。</strong></li>" : "";
  return html(`允许 ${clientName} 使用飞书`, `<h1>允许 ${clientName} ${write ? "读取和编辑" : "读取"}你的飞书？</h1><p class="account">授权账号：${escape(email)}</p><p>${clientName} 将能够使用这个账号已授权的飞书工具：</p><ul><li>搜索和阅读有权访问的文档及评论。</li><li>查看群聊、公告、历史消息、话题回复、群成员、Pin、标签页和表情反馈。</li><li>读取已补充授权的知识库、图片附件、表格、日程、任务和妙记文字记录。</li>${edits}${scope.includes("offline_access") ? "<li>自动续期本次 MCP 授权，最长 90 天。</li>" : ""}</ul><p>${write ? "仅对当前飞书账号有权访问的资源执行你明确要求的操作，具体功能仍须相应飞书权限。" : "本次授权仅允许读取；写入需要另外确认 feishu.write。"}本连接不提供机器人消息发送、群聊回复或撤回功能。</p><small>授权后返回：<strong>${new URL(redirectUri).hostname}</strong>。可在连接页面撤销授权。</small><form method="post" action="/api/claude-oauth/authorize"><input type="hidden" name="request_id" value="${escape(requestId)}"><input type="hidden" name="csrf_token" value="${escape(csrf)}"><button name="decision" value="allow">${write ? "允许读取和编辑" : "允许只读连接"}</button><button class="secondary" name="decision" value="deny">取消</button></form>`);
}
async function approve(env: OAuthContext, request: Request): Promise<Response> {
  const user = requireConsentUser(env, request);
  const params = await form(request);
  const decision = parameter(params, "decision", 10);
  if (!["allow", "deny"].includes(decision)) throw new OAuthError("invalid_request", "请选择允许或取消。");
  const db = database(env);
  const row = await db.prepare("DELETE FROM feishu_mcp_oauth_requests WHERE request_hash = ? AND user_id = ? AND csrf_hash = ? AND expires_at > ? RETURNING user_id, client_id, redirect_uri, challenge, state, resource, scope")
    .bind(await sha256(parameter(params, "request_id", 100)), user, await sha256(parameter(params, "csrf_token", 100)), now()).first<AuthorizationRequest>();
  if (!row) throw new OAuthError("invalid_request", "授权页面已过期或已使用，请从 AI 客户端重新连接。");
  const callback = new URL(row.redirect_uri);
  if (!officialCallback(callback.href)) throw new OAuthError("invalid_request", "回调地址不正确。");
  callback.searchParams.set("iss", issuer(env));
  if (row.state) callback.searchParams.set("state", row.state);
  if (decision === "deny") callback.searchParams.set("error", "access_denied");
  else {
    if (!await connected(env, user)) throw new OAuthError("access_denied", "飞书连接已解除，请重新授权。", 403);
    const code = randomString();
    await db.prepare("INSERT INTO feishu_mcp_oauth_codes (code_hash, user_id, client_id, redirect_uri, challenge, resource, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(await sha256(code), user, row.client_id, row.redirect_uri, row.challenge, row.resource, row.scope, now() + 120).run();
    callback.searchParams.set("code", code);
  }
  return new Response(null, { status: 303, headers: { ...noStore, Location: callback.href } });
}

type Code = { user_id: string; client_id: string; resource: string; scope: string };
async function exchangeCode(env: OAuthContext, params: URLSearchParams): Promise<Response> {
  const clientId = parameter(params, "client_id");
  const redirectUri = parameter(params, "redirect_uri");
  const resource = resourceParameter(env, parameter(params, "resource"));
  const verifier = parameter(params, "code_verifier", 128);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError("invalid_grant", "无效的 PKCE 校验值。");
  const db = database(env);
  // The conditional DELETE consumes the code exactly once, even for concurrent
  // exchanges. A wrong verifier/client/resource cannot consume a valid code.
  const row = await db.prepare("DELETE FROM feishu_mcp_oauth_codes WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND challenge = ? AND resource = ? AND expires_at > ? RETURNING user_id, client_id, resource, scope")
    .bind(await sha256(parameter(params, "code", 100)), clientId, redirectUri, await sha256(verifier), resource, now()).first<Code>();
  if (!row || !await connected(env, row.user_id)) throw new OAuthError("invalid_grant", "授权码无效、已过期或已使用。");
  const grantId = randomString();
  const access = `fsmcp_at_${randomString()}`;
  const offline = row.scope.split(" ").includes("offline_access");
  const refresh = offline ? `fsmcp_rt_${randomString()}` : null;
  const lifetime = offline ? GRANT_LIFETIME : ACCESS_LIFETIME;
  const statements = [
    db.prepare("INSERT INTO feishu_mcp_oauth_grants (grant_id, user_id, client_id, resource, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(grantId, row.user_id, row.client_id, row.resource, row.scope, now() + lifetime),
    db.prepare("INSERT INTO feishu_mcp_oauth_access (key_hash, grant_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(access), grantId, now() + ACCESS_LIFETIME),
  ];
  if (refresh) statements.push(db.prepare("INSERT INTO feishu_mcp_oauth_refresh (key_hash, grant_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(refresh), grantId, now() + REFRESH_LIFETIME));
  await db.batch(statements);
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_LIFETIME, scope: row.scope, ...(refresh ? { refresh_token: refresh } : {}) });
}
type Refresh = { grant_id: string; user_id: string; scope: string; expires_at: number; token_expires_at: number; consumed_at: number | null };
async function refreshToken(env: OAuthContext, params: URLSearchParams): Promise<Response> {
  const db = database(env);
  const resource = resourceParameter(env, parameter(params, "resource"));
  const keyHash = await sha256(parameter(params, "refresh_token", 100));
  const row = await db.prepare("SELECT g.grant_id, g.user_id, g.scope, g.expires_at, r.expires_at AS token_expires_at, r.consumed_at FROM feishu_mcp_oauth_refresh r JOIN feishu_mcp_oauth_grants g ON g.grant_id = r.grant_id WHERE r.key_hash = ? AND g.client_id = ? AND g.resource = ? AND g.revoked_at IS NULL AND g.expires_at > ?")
    .bind(keyHash, parameter(params, "client_id"), resource, now()).first<Refresh>();
  if (!row) throw new OAuthError("invalid_grant", "续期授权无效或已撤销。");
  if (row.consumed_at !== null) {
    await db.prepare("UPDATE feishu_mcp_oauth_grants SET revoked_at = ? WHERE grant_id = ?").bind(now(), row.grant_id).run();
    throw new OAuthError("invalid_grant", "检测到旧续期令牌重复使用，请重新连接。");
  }
  if (row.token_expires_at <= now() || !await connected(env, row.user_id)) throw new OAuthError("invalid_grant", "续期授权已过期或飞书连接已解除。");
  const requestedScope = parameter(params, "scope", 200);
  if (requestedScope && scopes(requestedScope) !== row.scope) throw new OAuthError("invalid_scope", "续期请求不能更改已授予的权限。");
  const rotation = randomString();
  const access = `fsmcp_at_${randomString()}`;
  const refresh = `fsmcp_rt_${randomString()}`;
  const stamp = now();
  const results = await db.batch([
    db.prepare("UPDATE feishu_mcp_oauth_refresh SET consumed_at = ?, rotation_id = ? WHERE key_hash = ? AND consumed_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM feishu_mcp_oauth_grants g WHERE g.grant_id = feishu_mcp_oauth_refresh.grant_id AND g.revoked_at IS NULL AND g.expires_at > ?)").bind(stamp, rotation, keyHash, stamp, stamp),
    db.prepare("INSERT INTO feishu_mcp_oauth_access (key_hash, grant_id, expires_at) SELECT ?, r.grant_id, ? FROM feishu_mcp_oauth_refresh r WHERE r.key_hash = ? AND r.rotation_id = ?").bind(await sha256(access), Math.min(stamp + ACCESS_LIFETIME, row.expires_at), keyHash, rotation),
    db.prepare("INSERT INTO feishu_mcp_oauth_refresh (key_hash, grant_id, expires_at) SELECT ?, r.grant_id, ? FROM feishu_mcp_oauth_refresh r WHERE r.key_hash = ? AND r.rotation_id = ?").bind(await sha256(refresh), Math.min(stamp + REFRESH_LIFETIME, row.expires_at), keyHash, rotation),
  ]);
  if (results[0].meta.changes !== 1) {
    await db.prepare("UPDATE feishu_mcp_oauth_grants SET revoked_at = ? WHERE grant_id = ?").bind(now(), row.grant_id).run();
    throw new OAuthError("invalid_grant", "续期令牌已使用，请重新连接。");
  }
  return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: Math.min(ACCESS_LIFETIME, row.expires_at - stamp), scope: row.scope });
}

export async function oauthAccess(env: OAuthContext, authorization: string | null): Promise<McpClientAccess> {
  const token = authorization?.match(/^Bearer (fsmcp_at_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new AppError("invalid_client_key", "请重新连接此 MCP 服务。", 401);
  const row = await database(env).prepare("SELECT g.user_id, g.scope FROM feishu_mcp_oauth_access a JOIN feishu_mcp_oauth_grants g ON g.grant_id = a.grant_id JOIN feishu_connections c ON c.user_id = g.user_id WHERE a.key_hash = ? AND a.expires_at > ? AND g.revoked_at IS NULL AND g.expires_at > ? AND g.resource = ?")
    .bind(await sha256(token), now(), now(), oauthResource(env)).first<{ user_id: string; scope: string }>();
  const granted = row?.scope.split(" ").filter(Boolean) || [];
  if (!row || !granted.includes(READ_SCOPE)) throw new AppError("invalid_client_key", "MCP 授权已过期、已撤销或范围无效，请重新连接。", 401);
  return { user_id: row.user_id, scopes: granted, authentication: "oauth" };
}
export async function oauthUser(env: OAuthContext, authorization: string | null): Promise<string> { return (await oauthAccess(env, authorization)).user_id; }
export async function revokeUserGrants(env: OAuthContext, user: string): Promise<void> {
  await database(env).prepare("UPDATE feishu_mcp_oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now(), user).run();
}

// Checks the deployed hosting boundary from the server, without registering a
// client or creating grants. No platform credential is included in the result.
export async function inspectOAuthDiscovery(env: OAuthContext) {
  const base = clientOrigin(env);
  const isGateway = base !== origin(env);
  const platformRequired = !isGateway && !publicClientMcp(env);
  if (platformRequired && !env.SITE_SERVICE_ACCESS) return { enabled: true, ready: false, platform_header_required: true, error: "platform_access_unavailable" };
  const probe = async (path: string, kind: "resource" | "issuer") => {
    try {
      const response = await fetch(base + path, { headers: { ...(platformRequired ? { "OAI-Sites-Authorization": `Bearer ${env.SITE_SERVICE_ACCESS}` } : {}), Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(6000) });
      const body = response.ok ? await response.json() as Record<string, unknown> : null;
      const valid = kind === "resource" ? body?.resource === oauthResource(env) && Array.isArray(body.authorization_servers) && body.authorization_servers[0] === issuer(env) : body?.issuer === issuer(env) && body?.token_endpoint === `${issuer(env)}/token` && body?.registration_endpoint === `${issuer(env)}/register` && body?.client_id_metadata_document_supported === true;
      return { status: response.status, valid: !!valid };
    } catch { return { status: 0, valid: false }; }
  };
  const [resource, authorizationServer, openidFallback] = await Promise.all([
    probe("/api/claude-oauth/resource", "resource"),
    probe("/.well-known/oauth-authorization-server/api/claude-oauth", "issuer"),
    probe("/api/claude-oauth/.well-known/openid-configuration", "issuer"),
  ]);
  // A 200 with the wrong issuer is not a usable fallback path for Claude.
  let mcpChallenge: { status: number; valid: boolean } | undefined;
  if (publicClientMcp(env)) {
    try {
      const response = await fetch(oauthResource(env), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "feishu-readiness", version: "1" } } }), redirect: "manual", signal: AbortSignal.timeout(6000) });
      mcpChallenge = { status: response.status, valid: response.status === 401 && !!response.headers.get("www-authenticate")?.includes(`${issuer(env)}/resource`) };
    } catch { mcpChallenge = { status: 0, valid: false }; }
  }
  let icon: { url: string; status: number; valid: boolean; mime_type?: string } | undefined;
  if (publicClientMcp(env)) {
    const url = `${origin(env)}/feishu-icon.png`;
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000) });
      const mime = response.headers.get("content-type")?.split(";")[0] || "";
      icon = { url, status: response.status, valid: response.ok && mime === "image/png", mime_type: mime };
      await response.body?.cancel();
    } catch { icon = { url, status: 0, valid: false }; }
  }
  return { enabled: true, ready: resource.valid && (authorizationServer.valid || (authorizationServer.status !== 200 && openidFallback.valid)) && (!mcpChallenge || mcpChallenge.valid), platform_header_required: platformRequired, mcp_url: oauthResource(env), oauth_client: "automatic", oauth_client_methods: CLIENT_METHODS.filter(method => method !== "manual" || !!env.MCP_OAUTH_CLIENT_ID), resource, authorization_server: authorizationServer, openid_fallback: openidFallback, ...(mcpChallenge ? { mcp_challenge: mcpChallenge } : {}), ...(icon ? { icon } : {}) };
}

export async function handleOAuthGet(env: OAuthContext, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/$/, "").slice("/api/claude-oauth".length);
  try {
    if (path === "/resource") return protectedResourceMetadata(env);
    if (["/metadata", "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"].includes(path)) return authorizationServerMetadata(env);
    if (path === "/authorize") return await authorize(env, request);
    if (path === "/setup") {
      requireBrowserUser(env, request);
      const platformRequired = clientOrigin(env) === origin(env) && !publicClientMcp(env);
      if (platformRequired && !env.SITE_SERVICE_ACCESS) throw new OAuthError("temporarily_unavailable", "平台访问设置尚未完成。", 503);
      return json({ url: oauthResource(env), headers: platformRequired ? { "OAI-Sites-Authorization": `Bearer ${env.SITE_SERVICE_ACCESS}` } : {}, authentication: "oauth", oauth_client: "automatic", oauth_client_methods: CLIENT_METHODS.filter(method => method !== "manual" || !!env.MCP_OAUTH_CLIENT_ID), client_secret_required: false, scopes: MCP_SCOPES, ...(env.MCP_OAUTH_CLIENT_ID ? { client_id: env.MCP_OAUTH_CLIENT_ID, redirect_uris: CALLBACKS } : {}) });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) { return failure(error, path === "/authorize"); }
}
export async function handleOAuthPost(env: OAuthContext, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/$/, "").slice("/api/claude-oauth".length);
  try {
    if (path === "/register") return await register(env, request);
    if (path === "/authorize") return await approve(env, request);
    if (path === "/token") {
      const params = await form(request);
      const grant = parameter(params, "grant_type", 100);
      if (grant === "authorization_code") return await exchangeCode(env, params);
      if (grant === "refresh_token") return await refreshToken(env, params);
      throw new OAuthError("unsupported_grant_type", "仅支持授权码和续期流程。");
    }
    if (path === "/revoke-all") {
      await revokeUserGrants(env, requireBrowserUser(env, request, true));
      return json({ revoked: true });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) { return failure(error, path === "/authorize"); }
}
