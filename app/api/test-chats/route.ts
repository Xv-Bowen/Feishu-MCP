import { env } from "cloudflare:workers";
import { POST as handleMcp } from "../../mcp/route";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录连接页面。" }, { status: 403 });
  return handleMcp(new Request(`${env.SITE_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "oai-authenticated-user-id": user }, body: JSON.stringify({ jsonrpc: "2.0", id: "chat-test", method: "tools/call", params: { name: "feishu_list_chats", arguments: { limit: 5 } } }) }));
}
