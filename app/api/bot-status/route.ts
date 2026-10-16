import { env } from "cloudflare:workers";
import { POST as handleMcp } from "../../mcp/route";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录连接页面。" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  let args: Record<string, unknown>;
  try {
    const body = await request.text();
    if (body.length > 4096) throw new Error();
    args = JSON.parse(body);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "chat_id")) throw new Error();
  } catch { return Response.json({ error: "检查参数无效，请重新选择群聊。" }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  return handleMcp(new Request(`${env.SITE_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "oai-authenticated-user-id": user }, body: JSON.stringify({ jsonrpc: "2.0", id: "bot-check", method: "tools/call", params: { name: "feishu_bot_status", arguments: args } }) }));
}
