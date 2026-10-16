import { env } from "cloudflare:workers";
import { AppError, safeMessage } from "../../../lib/core";
import { runExtensionTool } from "../../../lib/extension-tools";
import { MAX_UPLOAD_BYTES } from "../../../lib/file-transfers";
import { readLimited } from "../../../lib/resources";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user || request.headers.get("origin") !== env.SITE_ORIGIN) return Response.json({ error: "请登录并在连接页面上传。" }, { status: 403 });
  try {
    const bytes = await readLimited(new Response(request.body, { headers: request.headers }), MAX_UPLOAD_BYTES + 131072);
    const form = await new Response(new Blob([new Uint8Array(bytes)]), { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData(), file = form.get("file");
    if (!(file instanceof File) || file.size > MAX_UPLOAD_BYTES || file.size === 0) throw new AppError("invalid_input", "请选择 1 字节至 4 MiB 的文件。");
    const data = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.slice(i, i + 8192));
    const result = await runExtensionTool(env, user, "feishu_upload_file", { file_name: file.name, folder_token: String(form.get("folder_token") || ""), data_base64: btoa(binary), request_id: form.get("request_id") });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof AppError ? error.kind : "upload_failed", message: safeMessage(error) }, { status: error instanceof AppError ? error.status : 503, headers: { "Cache-Control": "no-store" } }); }
}
