import { AppError } from "./core";
import { accessToken, apiResponse, apiWithToken, providerError, type Runtime } from "./feishu";
import { identifier, stringField, tool, type Arguments } from "./workspace-common";

const ANNOUNCEMENT_SCOPE = "im:chat.announcement:read";
const EXTERNAL_BOT_HELP = "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/develop-robots/add-bot-to-external-group";
const CHAT_PATTERN = /^oc_[A-Za-z0-9_-]{8,100}$/;
type AppToken = { token: string; expiresAt: number };
type TokenPool = { appId: string; secret: string; current?: AppToken; pending?: Promise<AppToken> };
const tokenPools = new WeakMap<Runtime, TokenPool>();
const object = (value: unknown): Arguments => value && typeof value === "object" && !Array.isArray(value) ? value as Arguments : {};

export const BOT_TOOLS = [tool(
  "feishu_bot_status", "检查公告机器人",
  "检查本应用机器人的启用情况。指定群时先核对你本人已加入该群，再检查机器人是否在群内及是否可读公告元信息。不加群、不发消息、不修改配置；后台缺失的开通步骤会明确返回。",
  { chat_id: { ...stringField("可选：从你的群列表取得的群聊 ID", 104), pattern: "^oc_[A-Za-z0-9_-]{8,100}$" } }, [],
)];

export function botSetup(env: Runtime) {
  const app = typeof env.FEISHU_APP_ID === "string" && /^cli_[A-Za-z0-9_-]+$/.test(env.FEISHU_APP_ID) ? env.FEISHU_APP_ID : "";
  return {
    app_id: app || null,
    app_settings_url: app ? `https://open.feishu.cn/app/${app}` : "https://open.feishu.cn/app",
    external_bot_help_url: EXTERNAL_BOT_HELP,
    required_app_scopes: ["im:chat:read", ANNOUNCEMENT_SCOPE],
    setup_steps: [
      "在同一飞书应用中开启应用机器人能力，并发布生效。",
      "按飞书要求完成实名或组织认证，开启机器人的对外共享能力。",
      "在权限管理中开通应用身份的 im:chat:read 和 im:chat.announcement:read，并发布生效。",
      "在有权操作的目标群中添加此应用机器人，然后重新检查；能否添加取决于群设置。",
    ],
  };
}

async function issueAppToken(env: Runtime): Promise<AppToken> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new AppError("configuration_required", "飞书应用凭据尚未配置。", 503);
  const path = "/auth/v3/tenant_access_token/internal";
  const response = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }), signal: AbortSignal.timeout(20000),
  });
  if (response.status >= 300 && response.status < 400) throw new AppError("provider_redirect", "飞书机器人凭据接口发生跳转，已中止连接。", 502);
  const payload = object(await response.json());
  if (!response.ok || payload.code !== 0) providerError(response, payload, path, [env.FEISHU_APP_SECRET]);
  if (typeof payload.tenant_access_token !== "string" || !payload.tenant_access_token || /[\s\r\n]/.test(payload.tenant_access_token) || typeof payload.expire !== "number" || !Number.isInteger(payload.expire) || payload.expire <= 60 || payload.expire > 86400) {
    throw new AppError("invalid_response", "飞书未返回有效的机器人访问凭据。", 502);
  }
  return { token: payload.tenant_access_token, expiresAt: Date.now() + payload.expire * 1000 };
}

async function appToken(env: Runtime) {
  let pool = tokenPools.get(env);
  if (!pool || pool.appId !== env.FEISHU_APP_ID || pool.secret !== env.FEISHU_APP_SECRET) {
    pool = { appId: env.FEISHU_APP_ID || "", secret: env.FEISHU_APP_SECRET || "" };
    tokenPools.set(env, pool);
  }
  if (pool.current && pool.current.expiresAt > Date.now() + 60000) return pool.current.token;
  const selected = pool;
  if (!selected.pending) {
    const pending = issueAppToken(env);
    selected.pending = pending;
    void pending.then(value => { selected.current = value; if (selected.pending === pending) selected.pending = undefined; }, () => { if (selected.pending === pending) selected.pending = undefined; });
  }
  return (await selected.pending).token;
}

async function botInfo(token: string) {
  const path = "/bot/v3/info";
  const response = await apiResponse(token, path);
  if (response.status >= 300 && response.status < 400) throw new AppError("provider_redirect", "飞书机器人信息接口发生跳转，已中止连接。", 502);
  const payload = object(await response.json());
  if (!response.ok || payload.code !== 0) providerError(response, payload, path, [token]);
  // Bot Info returns bot at the top level, unlike the usual data envelope.
  const bot = object(payload.bot);
  if (typeof bot.open_id !== "string" || !/^ou_[A-Za-z0-9_-]+$/.test(bot.open_id) || typeof bot.activate_status !== "number") throw new AppError("invalid_response", "飞书未返回可确认的机器人身份。", 502);
  return {
    open_id: bot.open_id, name: typeof bot.app_name === "string" ? bot.app_name : null,
    activate_status: bot.activate_status, enabled: bot.activate_status === 2,
  };
}

async function isInChat(token: string, chat: string) {
  // Use the caller's own group list: knowing a public chat ID or being able to
  // see a group description never establishes membership. Do not cache this
  // check across users or pages of an announcement.
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("page_token", cursor);
    const data = object(await apiWithToken(token, `/im/v1/chats?${params}`));
    if ((data.items !== undefined && !Array.isArray(data.items)) || typeof data.has_more !== "boolean") throw new AppError("invalid_response", "飞书返回的群成员校验数据不完整。", 502);
    if ((data.items as unknown[] | undefined)?.some(value => object(value).chat_id === chat)) return true;
    if (!data.has_more) return false;
    if (typeof data.page_token !== "string" || !data.page_token || seen.has(data.page_token)) throw new AppError("invalid_response", "飞书群列表分页无效，无法确认群成员身份。", 502);
    cursor = data.page_token; seen.add(cursor);
  }
  throw new AppError("membership_check_incomplete", "群列表超过本次校验范围，尚未确认成员身份；没有读取机器人可见的公告。", 409);
}

async function userChatToken(env: Runtime, user: string, chat: string) {
  const token = await accessToken(env, user, ["im:chat:read", ANNOUNCEMENT_SCOPE]);
  if (!await isInChat(token, chat)) throw new AppError("chat_membership_required", "你本人未加入该群，不能借用机器人的身份读取公告。", 403);
  return token;
}

export function botFailure(error: unknown) {
  return {
    error: error instanceof AppError ? error.kind : "service_error",
    message: error instanceof AppError ? error.message : "机器人检查暂时未完成，请重试。",
    ...(error instanceof AppError && error.details ? error.details : {}),
  };
}

function annotateFailure(env: Runtime, error: unknown): AppError {
  if (!(error instanceof AppError)) return new AppError("bot_unavailable", "机器人检查暂时未完成，请重试。", 503, botSetup(env));
  const code = error.details?.provider_code;
  const message = code === 1772004 ? "飞书仍拒绝读取外部群公告。请检查此应用机器人的对外共享能力及群访问条件。"
    : [232025, 230006, 1772025].includes(Number(code)) ? "飞书应用机器人尚未启用或未发布，请先在应用后台开启机器人能力。"
    : [99991663, 99991668, 99991672, 99991679].includes(Number(code)) ? "机器人缺少应用身份权限。请在权限管理中开通并发布所需的应用身份权限；用户授权不能替代应用身份权限。"
    : error.message;
  return new AppError(error.kind, message, error.status, { ...error.details, ...botSetup(env) });
}

export async function announcementBotToken(env: Runtime, user: string, chat: string) {
  // The user's current grant and membership must be verified before minting or
  // using any tenant-wide credential, including on continuation requests.
  await userChatToken(env, user, chat);
  try {
    const token = await appToken(env), bot = await botInfo(token);
    if (!bot.enabled) throw new AppError("bot_not_enabled", "应用机器人未激活或已停用，请在飞书后台检查并发布。", 403);
    if (!await isInChat(token, chat)) throw new AppError("bot_not_in_chat", "此应用机器人尚未加入目标群，请先在有权操作的群中添加该机器人。", 403, { bot_name: bot.name, bot_open_id: bot.open_id });
    return token;
  } catch (error) { throw annotateFailure(env, error); }
}

export async function runBotStatus(env: Runtime, user: string, args: Arguments) {
  const chat = args.chat_id === undefined ? undefined : identifier(args.chat_id, "群聊 ID", CHAT_PATTERN);
  // Even a global bot check requires this caller's own valid Feishu connection.
  await accessToken(env, user, chat ? ["im:chat:read", ANNOUNCEMENT_SCOPE] : []);
  if (chat) await userChatToken(env, user, chat);
  const setup = botSetup(env);
  let bot: Awaited<ReturnType<typeof botInfo>> | undefined;
  let inChat: boolean | null = null;
  try {
    const token = await appToken(env); bot = await botInfo(token);
    if (!bot.enabled) throw new AppError("bot_not_enabled", "应用机器人未激活或已停用，请在飞书后台检查并发布。", 403);
    if (chat) {
      inChat = await isInChat(token, chat);
      if (!inChat) throw new AppError("bot_not_in_chat", "此应用机器人尚未加入目标群，请先在有权操作的群中添加该机器人。", 403);
      const meta = object(await apiWithToken(token, `/docx/v1/chats/${chat}/announcement?user_id_type=open_id`));
      if (meta.announcement_type !== "doc" && meta.announcement_type !== "docx") throw new AppError("invalid_response", "飞书未返回可识别的公告类型。", 502);
      return { ...setup, bot, chat_id: chat, user_in_chat: true, bot_in_chat: true, announcement_metadata_readable: true, announcement_type: meta.announcement_type, content_read_verified: false, next_step: "公告元信息校验通过；使用读取群公告工具继续核对正文。" };
    }
    return { ...setup, bot, chat_id: null, bot_in_chat: null, announcement_metadata_readable: null, content_read_verified: false, next_step: "提供目标群 ID，继续检查入群情况和公告访问权限。" };
  } catch (error) {
    const failure = annotateFailure(env, error);
    return { ...setup, bot: bot || null, chat_id: chat || null, user_in_chat: chat ? true : null, bot_in_chat: inChat, announcement_metadata_readable: null, content_read_verified: false, diagnostic: botFailure(failure), next_step: failure.message };
  }
}
