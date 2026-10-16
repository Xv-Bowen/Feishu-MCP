import { env } from "cloudflare:workers";
import { issueClientKey } from "../../../lib/client-access";
import { AppError, safeMessage } from "../../../lib/core";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录本服务的连接页面。" }, { status: 403, headers });
  try { return Response.json(await issueClientKey(env, user), { headers }); }
  catch (e) { return Response.json({ error: safeMessage(e) }, { status: e instanceof AppError ? e.status : 503, headers }); }
}
export async function DELETE(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录本服务的连接页面。" }, { status: 403, headers });
  if (env.DB) await env.DB.prepare("DELETE FROM feishu_client_keys WHERE user_id = ?").bind(user).run();
  return Response.json({ revoked: true }, { headers });
}
