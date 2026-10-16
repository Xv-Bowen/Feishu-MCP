import { env } from "cloudflare:workers";
import { disconnect, status } from "../../../lib/feishu";
import { safeMessage } from "../../../lib/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return Response.json(await status(env, request.headers.get("oai-authenticated-user-id")), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return Response.json({ error: safeMessage(e) }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录连接页面。" }, { status: 403 });
  await disconnect(env, user);
  return new Response(null, { status: 303, headers: { Location: "/?disconnected=1", "Cache-Control": "no-store" } });
}
