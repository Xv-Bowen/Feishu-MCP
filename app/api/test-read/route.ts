import { env } from "cloudflare:workers";
import { POST as handleMcp } from "../../mcp/route";
import { documentId } from "../../../lib/core";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录连接页面再测试。" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  let document: string;
  try {
    const text = await request.text();
    if (text.length > 4096) throw new Error("Request too large");
    document = documentId(JSON.parse(text).document);
  } catch {
    return Response.json({ error: "请输入你有权访问的飞书新版文档链接或文档 ID。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // Reads retain the authenticated visitor's own Feishu permissions.
  return handleMcp(new Request(`${env.SITE_ORIGIN}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "oai-authenticated-user-id": user },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feishu_read_document", arguments: { document, max_characters: 1000 } } }),
  }));
}
