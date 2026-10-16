import { AppError, boundedInteger } from "./core";
import { accessToken, apiWithToken, type Runtime } from "./feishu";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const cursor = { type: "string", maxLength: 4096, description: "上一页返回的 page_token；继续分页时保留原查询条件。" };
const chatIdSchema = { type: "string", pattern: "^oc_[A-Za-z0-9_-]{8,100}$", description: "从群列表或消息搜索结果取得的 chat_id。" };
const timeSchema = { type: "string", description: "带时区的 ISO 8601 时间，例如 2026-10-12T00:00:00+08:00。" };
const paging = (maximum: number, value: number) => ({ limit: { type: "integer", minimum: 1, maximum, default: value }, page_token: cursor });
export const CHAT_TOOLS = [
  { name: "feishu_list_chats", title: "查看加入的群聊", description: "查看你加入的飞书群聊，返回群名称、群聊 ID 等信息，支持分页。读取全部页面后才能获得完整列表。", inputSchema: { type: "object", properties: paging(100, 20), additionalProperties: false }, annotations },
  { name: "feishu_read_chat_messages", title: "读取群聊历史", description: "查看指定群聊中你有权访问的历史消息，默认从最近消息开始。可按时间范围筛选，支持分页；话题内的回复可通过「读取话题回复」继续查看。", inputSchema: { type: "object", properties: { chat_id: chatIdSchema, ...paging(50, 10), order: { type: "string", enum: ["asc", "desc"], default: "desc" }, start_time: timeSchema, end_time: timeSchema }, required: ["chat_id"], additionalProperties: false }, annotations },
  { name: "feishu_read_thread_messages", title: "读取话题回复", description: "查看指定话题中你有权访问的回复，支持按时间顺序阅读与分页。使用群聊历史或消息搜索结果提供的话题 ID。", inputSchema: { type: "object", properties: { thread_id: { type: "string", pattern: "^omt_[A-Za-z0-9_-]{8,100}$" }, ...paging(50, 10), order: { type: "string", enum: ["asc", "desc"], default: "asc" } }, required: ["thread_id"], additionalProperties: false }, annotations },
  { name: "feishu_search_chat_messages", title: "搜索群聊消息", description: "按关键词搜索你可见的群聊消息，可限定群聊和时间范围。返回匹配片段及消息、话题 ID，支持分页；匹配片段不代表完整消息正文。", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 50 }, chat_id: chatIdSchema, ...paging(30, 10), start_time: timeSchema, end_time: timeSchema }, required: ["query"], additionalProperties: false }, annotations },
  { name: "feishu_list_chat_members", title: "查看群成员", description: "查看你有权访问的群聊成员名单，支持分页。若飞书限制返回人数或仍有后续页面，结果会说明名单尚不完整。", inputSchema: { type: "object", properties: { chat_id: chatIdSchema, ...paging(100, 20) }, required: ["chat_id"], additionalProperties: false }, annotations },
];
const MESSAGE_SCOPES = ["im:message:readonly", "im:message.group_msg:get_as_user"];
export const CHAT_TOOL_SCOPES: Record<string, string[]> = {
  feishu_list_chats: ["im:chat:read"],
  feishu_read_chat_messages: MESSAGE_SCOPES,
  feishu_read_thread_messages: MESSAGE_SCOPES,
  feishu_search_chat_messages: ["search:message"],
  feishu_list_chat_members: ["im:chat.members:read"],
};

function identifier(value: unknown, prefix: "oc" | "omt"): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,100}$`).test(value)) throw new AppError("invalid_input", `请提供有效的 ${prefix === "oc" ? "chat_id" : "thread_id"}。`);
  return value;
}
function page(args: Record<string, unknown>, maximum: number, fallback: number) {
  const params = new URLSearchParams({ page_size: String(boundedInteger(args.limit, fallback, 1, maximum)) });
  if (args.page_token !== undefined) {
    if (typeof args.page_token !== "string" || args.page_token.length > 4096 || /[\r\n\0]/.test(args.page_token)) throw new AppError("invalid_input", "分页游标格式不正确。");
    if (args.page_token) params.set("page_token", args.page_token);
  }
  return params;
}
function order(args: Record<string, unknown>, fallback: "asc" | "desc") {
  const value = args.order ?? fallback;
  if (value !== "asc" && value !== "desc") throw new AppError("invalid_input", "order 只支持 asc 或 desc。");
  return value === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc";
}
function timeRange(args: Record<string, unknown>): { start_time?: string; end_time?: string } {
  const result: { start_time?: string; end_time?: string } = {};
  for (const field of ["start_time", "end_time"] as const) {
    const value = args[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) < 0) throw new AppError("invalid_input", "时间必须使用带时区的 ISO 8601 格式。");
    result[field] = value;
  }
  if (result.start_time && result.end_time && Date.parse(result.start_time) >= Date.parse(result.end_time)) throw new AppError("invalid_input", "结束时间必须晚于开始时间。");
  return result;
}
function pagination(data: { has_more?: boolean; page_token?: string }) {
  const more = data.has_more === true;
  return { has_more: more, page_token: more && typeof data.page_token === "string" ? data.page_token : null, complete: !more };
}
function timestamp(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  return Number.isFinite(number) && number >= 0 && number <= 8640000000000000 ? new Date(number).toISOString() : String(value);
}
function plain(value: string) { return value.replace(/<\/?h>/g, "").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
function postText(value: unknown, depth = 0): string {
  if (depth > 8 || !value) return "";
  if (Array.isArray(value)) return value.map(item => postText(item, depth + 1)).filter(Boolean).join(value.some(Array.isArray) ? "\n" : "");
  if (typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (node.tag === "img") return "[图片]";
  if (node.tag === "emotion") return typeof node.emoji_type === "string" ? `[${node.emoji_type}]` : "";
  if (typeof node.text === "string") return plain(node.text) + (typeof node.href === "string" && node.href !== node.text ? ` (${node.href})` : "");
  if (node.tag === "at") return typeof node.user_name === "string" ? `@${node.user_name}` : "@成员";
  const title = typeof node.title === "string" ? node.title + "\n" : "";
  if (node.content !== undefined) return title + postText(node.content, depth + 1);
  if (node.content_v2 !== undefined) return title + postText(node.content_v2, depth + 1);
  for (const language of ["zh_cn", "en_us", "ja_jp"]) if (node[language]) return postText(node[language], depth + 1);
  return title;
}
export function messageContent(raw: unknown, type: string, maximum = 12000) {
  if (typeof raw !== "string") return { content: "", content_truncated: false, format: "plain_text" };
  let text = raw;
  const resources: Array<{ resource_token: string; kind: string; file_name?: string }> = [];
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const inspect = (node: unknown, depth = 0) => {
      if (!node || typeof node !== "object" || depth > 8 || resources.length >= 20) return;
      if (Array.isArray(node)) { for (const child of node) inspect(child, depth + 1); return; }
      const item = node as Record<string, unknown>;
      for (const [key, kind] of [["image_key", "message_image"], ["file_key", "message_file"]]) {
        const token = item[key];
        if (typeof token === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(token) && !resources.some(resource => resource.resource_token === token)) resources.push({ resource_token: token, kind, ...(typeof item.file_name === "string" ? { file_name: item.file_name.slice(0,200) } : {}) });
      }
      for (const child of Object.values(item)) inspect(child, depth + 1);
    };
    inspect(body);
    if (type === "post") text = postText(body).trim() || raw;
    else if (typeof body.text === "string") text = plain(body.text);
    else if (type === "image") text = "[图片：正文接口不下载图片]";
    else if (["file", "audio", "media", "video", "sticker"].includes(type)) text = `[${type}${typeof body.file_name === "string" ? `：${body.file_name}` : ""}：未下载附件]`;
  } catch { /* Some providers return plain text instead of serialized JSON. */ }
  return { content: text.slice(0, maximum), content_truncated: text.length > maximum, format: "plain_text_or_message_json", resources };
}
type Message = { message_id?: string; chat_id?: string; thread_id?: string; msg_type?: string; create_time?: string; update_time?: string; message_position?: string; deleted?: boolean; updated?: boolean; sender?: { id?: string; sender_type?: string; sender_name?: string }; body?: { content?: string } };
function message(item: Message) {
  const url = item.chat_id ? new URL("https://applink.feishu.cn/client/chat/open") : null;
  if (url) { url.searchParams.set("openChatId", item.chat_id!); if (item.message_position && /^\d+$/.test(item.message_position)) url.searchParams.set("position", item.message_position); }
  return { message_id: item.message_id, chat_id: item.chat_id, thread_id: item.thread_id || null, type: item.msg_type, create_time: timestamp(item.create_time), update_time: item.updated ? timestamp(item.update_time) : null, deleted: item.deleted === true, sender: { id: item.sender?.id, name: item.sender?.sender_name || item.sender?.id, type: item.sender?.sender_type }, ...(item.deleted ? { content: "[消息已撤回]", content_truncated: false, format: "plain_text" } : messageContent(item.body?.content, item.msg_type || "unknown")), message_url: url?.toString() || null };
}

export async function runChatTool(env: Runtime, user: string, name: string, args: Record<string, unknown>) {
  if (name === "feishu_list_chats") {
    const params = page(args, 100, 20);
    params.set("user_id_type", "open_id"); params.set("sort_type", "ByCreateTimeAsc");
    const data = await apiWithToken(await accessToken(env, user, CHAT_TOOL_SCOPES[name]), `/im/v1/chats?${params}`) as { items?: Array<{ chat_id?: string; name?: string; description?: string; external?: boolean; chat_mode?: string; chat_status?: string }>; has_more?: boolean; page_token?: string };
    return { chats: (data.items || []).map(item => ({ chat_id: item.chat_id, name: item.name, description: item.description?.slice(0, 2000), external: item.external, mode: item.chat_mode, status: item.chat_status })), ...pagination(data) };
  }
  if (name === "feishu_read_chat_messages" || name === "feishu_read_thread_messages") {
    const isThread = name === "feishu_read_thread_messages";
    const container = identifier(args[isThread ? "thread_id" : "chat_id"], isThread ? "omt" : "oc");
    const params = page(args, 50, 10);
    params.set("container_id_type", isThread ? "thread" : "chat"); params.set("container_id", container); params.set("sort_type", order(args, isThread ? "asc" : "desc")); params.set("with_sender_name", "true");
    if (!isThread) {
      params.set("only_thread_root_messages", "true");
      for (const [key, value] of Object.entries(timeRange(args))) params.set(key, String(Math.floor(Date.parse(value!) / 1000)));
    }
    const data = await apiWithToken(await accessToken(env, user, CHAT_TOOL_SCOPES[name]), `/im/v1/messages?${params}`) as { items?: Message[]; has_more?: boolean; page_token?: string };
    return { container_id: container, messages: (data.items || []).map(message), ...pagination(data), note: isThread ? "仅返回当前页的可见回复。" : "话题回复需要使用 thread_id 调用 feishu_read_thread_messages；图片和附件未下载。" };
  }
  if (name === "feishu_search_chat_messages") {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 50) throw new AppError("invalid_input", "消息关键词须为 1 到 50 个字符。");
    const params = page(args, 30, 10);
    const filter: Record<string, unknown> = { chat_type: "group" };
    if (args.chat_id !== undefined) filter.chat_ids = [identifier(args.chat_id, "oc")];
    const range = timeRange(args); if (Object.keys(range).length) filter.time_range = range;
    const data = await apiWithToken(await accessToken(env, user, CHAT_TOOL_SCOPES[name]), `/im/v1/messages/search?${params}`, { query: args.query.trim(), filter }) as { items?: Array<{ id?: string; display_info?: string; meta_data?: Record<string, unknown> }>; has_more?: boolean; page_token?: string; total?: number; notice?: string };
    return { matches: (data.items || []).map(item => ({ message_id: item.meta_data?.message_id || item.id, chat_id: item.meta_data?.chat_id, thread_id: item.meta_data?.thread_id || null, sender_id: item.meta_data?.from_id, create_time: item.meta_data?.create_time, type: item.meta_data?.type, snippet: typeof item.display_info === "string" ? plain(item.display_info).slice(0, 4000) : "" })), ...pagination(data), total: data.total ?? null, notice: data.notice || null, note: "搜索返回匹配片段，不是完整正文；不会自动拉取所有历史消息。" };
  }
  if (name === "feishu_list_chat_members") {
    const chat = identifier(args.chat_id, "oc"), params = page(args, 100, 20);
    params.set("member_id_type", "open_id");
    const data = await apiWithToken(await accessToken(env, user, CHAT_TOOL_SCOPES[name]), `/im/v1/chats/${encodeURIComponent(chat)}/members/list?${params}`) as { users?: Array<{ member_id?: string; name?: string }>; bots?: Array<{ member_id?: string; app_id?: string; name?: string }>; has_more?: boolean; page_token?: string; user_total?: number; bot_total?: number; truncations?: unknown[] };
    const truncations = Array.isArray(data.truncations) ? data.truncations : [];
    return { chat_id: chat, users: (data.users || []).map(item => ({ id: item.member_id, name: item.name })), bots: (data.bots || []).map(item => ({ id: item.member_id, app_id: item.app_id, name: item.name })), user_total: typeof data.user_total === "number" && data.user_total >= 0 ? data.user_total : null, bot_total: data.bot_total ?? null, ...pagination(data), complete: data.has_more !== true && truncations.length === 0, truncations, note: truncations.length ? "服务端限制了返回人数，此名单不完整。" : "返回条数可能与请求的 limit 不同，是否完整以 complete 为准。" };
  }
  throw new AppError("unknown_tool", "未知群聊工具。");
}
