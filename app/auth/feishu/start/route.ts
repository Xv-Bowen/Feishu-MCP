import { env } from "cloudflare:workers";
import { startAuthorization } from "../../../../lib/feishu";
import { AppError } from "../../../../lib/core";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录连接页面再开始授权。" }, { status: 403 });
  try {
    let features: string[] = [];
    if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      const body = await request.text();
      if (body.length > 4096) throw new AppError("invalid_input", "授权选项过长。");
      features = new URLSearchParams(body).getAll("features");
    }
    return new Response(null, { status: 303, headers: { Location: await startAuthorization(env, user, features), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  catch (error) {
    const kind = error instanceof AppError ? error.kind : "service_error";
    console.error("feishu_authorization_start_failed", { kind, error_type: error instanceof Error ? error.name : "unknown" });
    return new Response(null, { status: 303, headers: { Location: `/?error=${kind}`, "Cache-Control": "no-store" } });
  }
}
