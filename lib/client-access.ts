import { AppError } from "./core";
import { randomString, sha256 } from "./crypto";
import { WORKSPACE_READ_TOOLS, WORKSPACE_TOOLS } from "./workspace-tools";

const BASE_CLIENT_TOOLS = ["feishu_connection_status", "feishu_search_documents", "feishu_read_document", "feishu_list_chats", "feishu_read_chat_messages", "feishu_read_thread_messages", "feishu_search_chat_messages", "feishu_list_chat_members"];
export const CLIENT_READ_TOOLS = [...BASE_CLIENT_TOOLS, ...WORKSPACE_READ_TOOLS];
export const CLIENT_WRITE_TOOLS = WORKSPACE_TOOLS.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name);
export const CLIENT_TOOLS = [...BASE_CLIENT_TOOLS, ...WORKSPACE_TOOLS.map(tool => tool.name)];
const now = () => Math.floor(Date.now() / 1000);
type Context = { DB?: D1Database; SITE_ORIGIN?: string; SITE_SERVICE_ACCESS?: string; CLIENT_MCP_PUBLIC?: string };

export async function issueClientKey(env: Context, user: string) {
  const publicMcp = env.CLIENT_MCP_PUBLIC === "true";
  if (!env.DB || (!publicMcp && !env.SITE_SERVICE_ACCESS) || !env.SITE_ORIGIN) throw new AppError("client_access_unavailable", "客户端连接设置尚未完成，请稍后重试。", 503);
  const key = `fsmcp_${randomString()}`;
  const expires = now() + 90 * 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feishu_client_keys WHERE user_id = ? OR expires_at < ?").bind(user, now()),
    env.DB.prepare("INSERT INTO feishu_client_keys (key_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(key), user, now(), expires),
  ]);
  return { url: `${env.SITE_ORIGIN}/api/client-mcp`, headers: { ...(!publicMcp ? { "OAI-Sites-Authorization": `Bearer ${env.SITE_SERVICE_ACCESS}` } : {}), Authorization: `Bearer ${key}` }, expires_at: expires };
}

export async function clientUser(env: Context, authorization: string | null): Promise<string> {
  if (!env.DB) throw new AppError("client_access_unavailable", "客户端连接存储不可用。", 503);
  const match = authorization?.match(/^Bearer (fsmcp_[A-Za-z0-9_-]{43})$/);
  if (!match) throw new AppError("invalid_client_key", "请使用连接页面生成的客户端凭据。", 401);
  const row = await env.DB.prepare("SELECT user_id FROM feishu_client_keys WHERE key_hash = ? AND expires_at > ?").bind(await sha256(match[1]), now()).first<{ user_id: string }>();
  if (!row) throw new AppError("invalid_client_key", "客户端凭据已过期或已撤销，请重新生成。", 401);
  return row.user_id;
}
