import { AppError } from "./core";
import { apiResponse, providerError, type Runtime } from "./feishu";
import { readLimited } from "./resources";
import { identifier, resourceToken, stringField, type Arguments } from "./workspace-common";
import { callApi, enumField, integration, obj, queryPath } from "./integration-common";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const resource = stringField("云文档 token 或对应 docx/sheets/base/slides 链接"), folder = { ...stringField("目标文件夹 token，空字符串表示根目录", 100), minLength: 0 };
const exportFormats: Record<string, string[]> = { doc: ["docx", "pdf"], docx: ["docx", "pdf", "markdown"], sheet: ["xlsx", "csv"], bitable: ["xlsx", "csv", "base"], slides: ["pptx", "pdf"] };
const importFormats: Record<string, string[]> = { docx: ["doc", "docx", "txt", "md", "mark", "markdown", "html"], sheet: ["xls", "xlsx", "csv"], bitable: ["xlsx", "csv", "base"], slides: ["pptx"] };
export function decodeUpload(value: unknown) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new AppError("invalid_input", "请提供标准 Base64 文件内容，文件最多 4 MiB。");
  let decoded: string; try { decoded = atob(value); } catch { throw new AppError("invalid_input", "Base64 文件内容无效。"); }
  if (!decoded.length || decoded.length > MAX_UPLOAD_BYTES) throw new AppError("invalid_input", "上传文件须为 1 字节至 4 MiB。");
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
export async function uploadFile(token: string, args: Arguments) {
  const bytes = decodeUpload(args.data_base64), name = String(args.file_name);
  if (/[\r\n\0/\\]/.test(name) || name === "." || name === "..") throw new AppError("invalid_input", "文件名不能包含路径或控制字符。");
  const form = new FormData(); form.set("file_name", name); form.set("parent_type", "explorer"); form.set("parent_node", args.folder_token ? identifier(args.folder_token) : ""); form.set("size", String(bytes.length)); form.set("file", new Blob([bytes]), name);
  const response = await fetch("https://open.feishu.cn/open-apis/drive/v1/files/upload_all", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, redirect: "manual", signal: AbortSignal.timeout(30000) });
  if (response.status >= 300 && response.status < 400) throw new AppError("provider_redirect", "上传接口发生跳转，已中止。", 502);
  const payload = await response.json() as { code?: number; data?: Arguments };
  if (!response.ok || Number(payload.code) !== 0) providerError(response, payload, "/drive/v1/files/upload_all", [token]);
  if (!payload.data?.file_token) throw new AppError("invalid_response", "飞书未返回上传文件标识。", 502);
  return { ...payload.data, file_name: name, size_bytes: bytes.length };
}

export function jobStatus(data: Arguments, exporting: boolean): Arguments & { state: string; complete: boolean } {
  const result = obj(data.result), code = Number(result.job_status), hasArtifact = !!result[exporting ? "file_token" : "token"];
  const state = code === 0 && hasArtifact ? "succeeded" : [0, 1, 2].includes(code) ? "pending" : "failed";
  return { ...data, state, complete: state !== "pending" };
}
export async function exportResponse(token: string, fileToken: string) {
  const path = `/drive/v1/export_tasks/file/${identifier(fileToken)}/download`;
  const response = await apiResponse(token, path);
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AppError("provider_redirect", "导出下载发生跳转，请重新查询导出任务。", 502); }
  if (!response.ok) { let payload = {}; try { payload = await response.json(); } catch {} providerError(response, payload, path, [token]); }
  if ((response.headers.get("content-type") || "").includes("application/json")) { const payload = JSON.parse(new TextDecoder().decode(await readLimited(response, 65536))); providerError(response, payload, path, [token]); }
  return response;
}
export const FILE_INTEGRATIONS = [
  integration("feishu_upload_file", "上传文件到飞书", "把用户提供的文件上传到飞书云空间，最多 4 MiB。data_base64 是文件原始字节的标准 Base64；可在连接页面直接选文件上传。不会覆盖同名旧文件。", { file_name: stringField("原文件名，保留扩展名", 200), folder_token: folder, data_base64: { type: "string", minLength: 4, maxLength: Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 } }, ["file_name", "data_base64"], ["drive:file:upload"], async (_e, _u, a, token) => uploadFile(token, a), true),
  integration("feishu_create_import", "导入为飞书云文档", "将已上传的文件转换为云文档、电子表格、多维表格或幻灯片。返回异步 ticket；随后查询导入任务，不能把已受理当作导入成功。", { file_token: stringField("上传工具返回的 file_token", 100), file_extension: enumField(["doc", "docx", "txt", "md", "mark", "markdown", "html", "xls", "xlsx", "csv", "base", "pptx"]), target_type: enumField(["docx", "sheet", "bitable", "slides"]), file_name: stringField("导入后的名称", 200), folder_token: folder }, ["file_token", "file_extension", "target_type", "file_name"], ["docs:document:import"], async (_e, _u, a, token) => {
    if (!importFormats[String(a.target_type)]?.includes(String(a.file_extension))) throw new AppError("invalid_input", "源文件扩展名与目标云文档类型不匹配。");
    return { ...await callApi(token, "/drive/v1/import_tasks", { file_extension: a.file_extension, file_token: identifier(a.file_token), type: a.target_type, file_name: a.file_name, point: { mount_type: 1, mount_key: a.folder_token ? identifier(a.folder_token) : "" } }), state: "pending", complete: false };
  }, true),
  integration("feishu_get_import", "查询导入进度", "查询导入 ticket；只有 state=succeeded 且返回产物 token 才能认为完成。", { ticket: stringField("导入 ticket", 200) }, ["ticket"], ["docs:document:import"], async (_e, _u, a, token) => jobStatus(await callApi(token, `/drive/v1/import_tasks/${encodeURIComponent(identifier(a.ticket, "ticket", /^[A-Za-z0-9_-]{1,200}$/))}`), false)),
  integration("feishu_create_export", "导出飞书云文档", "创建导出任务。文档可导出 PDF/Word 等，表格可导出 Excel/CSV；CSV 须指定 sub_id。返回 ticket 后继续查询，不立即提供虚构下载链接。", { resource, resource_type: enumField(["doc", "docx", "sheet", "bitable", "slides"]), file_extension: enumField(["docx", "pdf", "markdown", "xlsx", "csv", "base", "pptx"]), sub_id: stringField("CSV 必须填写工作表或数据表 ID", 100) }, ["resource", "resource_type", "file_extension"], ["docs:document:export"], async (_e, _u, a, token) => {
    const id = resourceToken(a.resource, ["doc", "docx", "sheets", "base", "bitable", "slides"]);
    if (!exportFormats[String(a.resource_type)]?.includes(String(a.file_extension)) || a.file_extension === "csv" && !a.sub_id) throw new AppError("invalid_input", "导出格式不受该资源类型支持，或 CSV 缺少 sub_id。");
    return { ...await callApi(token, "/drive/v1/export_tasks", { token: id, type: a.resource_type, file_extension: a.file_extension, ...(a.sub_id ? { sub_id: identifier(a.sub_id, "子表 ID", /^[A-Za-z0-9_-]{1,100}$/) } : {}) }), resource_token: id, state: "pending", complete: false };
  }, true),
  integration("feishu_get_export", "查询导出进度", "查询导出结果，成功后提供需要当前账号登录的下载链接。只返回飞书实际完成的文件。", { ticket: stringField("导出 ticket", 200), resource_token: stringField("创建任务返回的 resource_token", 100) }, ["ticket", "resource_token"], ["docs:document:export"], async (e, _u, a, token) => {
    const data = jobStatus(await callApi(token, queryPath(`/drive/v1/export_tasks/${encodeURIComponent(identifier(a.ticket, "ticket", /^[A-Za-z0-9_-]{1,200}$/))}`, { token: identifier(a.resource_token) })), true);
    if (data.state !== "succeeded") return data;
    const result = obj(data.result), url = new URL("/api/export-download", e.SITE_ORIGIN); url.searchParams.set("file_token", String(result.file_token)); url.searchParams.set("file_name", String(result.file_name || "feishu-export"));
    return { ...data, download_url: url.toString(), requires_site_login: true };
  }),
];
