import { env } from "cloudflare:workers";
import { AppError, safeMessage } from "../../../lib/core";
import { accessToken } from "../../../lib/feishu";
import { exportResponse } from "../../../lib/file-transfers";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user) return Response.json({ error: "请登录连接页面后下载。" }, { status: 401 });
  try {
    const p = new URL(request.url).searchParams;
    const response = await exportResponse(await accessToken(env, user, ["docs:document:export"]), p.get("file_token") || "");
    const maximum = 64 * 1024 * 1024; let size = 0;
    if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new AppError("resource_too_large", "本站导出下载上限为 64 MiB。", 413); }
    const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > maximum) controller.error(new Error("Download size limit")); else controller.enqueue(chunk); } }));
    const name = (p.get("file_name") || "feishu-export").replace(/[\r\n\0/\\]/g, "_").slice(0, 200);
    return new Response(stream, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="feishu-export"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
  } catch (error) { return Response.json({ error: error instanceof AppError ? error.kind : "download_failed", message: safeMessage(error) }, { status: error instanceof AppError ? error.status : 503, headers: { "Cache-Control": "no-store" } }); }
}
