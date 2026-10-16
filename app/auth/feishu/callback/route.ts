import { env } from "cloudflare:workers";
import { finishAuthorization } from "../../../../lib/feishu";
import { AppError, diagnosticMessage } from "../../../../lib/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const user = request.headers.get("oai-authenticated-user-id");
  let location = "/?connected=1";
  try {
    if (!user) throw new AppError("identity_required", "请先登录连接页面。");
    await finishAuthorization(env, user, url.searchParams.get("code"), url.searchParams.get("state"), url.searchParams.has("error"));
  } catch (error) {
    const kind = error instanceof AppError ? error.kind : "service_error";
    console.error("feishu_authorization_callback_failed", { kind, error_type: error instanceof Error ? error.name : "unknown", detail: diagnosticMessage(error, [env.FEISHU_APP_SECRET, env.TOKEN_ENCRYPTION_KEY, user, url.searchParams.get("code"), url.searchParams.get("state")]) });
    location = `/?error=${kind}`;
  }
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
