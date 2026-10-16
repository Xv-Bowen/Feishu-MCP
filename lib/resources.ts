import { AppError } from "./core";
import { accessToken, apiResponse, providerError, type Runtime } from "./feishu";
import { identifier, stringField, tool, type Arguments } from "./workspace-common";

const resourceFields = { resource_token: stringField("从文档结构或消息正文中取得的文件 token 或 file_key",100), kind: { type: "string", enum: ["media","file","message_image","message_file"], default: "media", description: "media 是文档图片附件，file 是云空间文件，message_* 是聊天消息资源" }, message_id: stringField("聊天资源所属消息的 om_ ID",100), file_name: stringField("下载时显示的文件名",200) };
export const RESOURCE_TOOLS = [
  tool("feishu_get_resource_download", "下载图片或附件", "校验资源访问权并提供需登录此私有站点的下载链接。支持文档素材、云空间文件及有权访问的消息资源。",resourceFields,["resource_token"]),
  tool("feishu_read_image", "读取飞书图片", "读取文档或聊天图片，供 AI 直接查看；仅支持 PNG/JPEG/GIF/WebP，单图最多 5 MB。",resourceFields,["resource_token"]),
];

export function resourceParameters(args: Arguments) {
  const token = identifier(args.resource_token,"文件 token 或 file_key");
  const kind = args.kind === undefined ? "media" : args.kind;
  if (!["media","file","message_image","message_file"].includes(String(kind))) throw new AppError("invalid_input","资源类型无效。");
  const message = String(kind).startsWith("message_") ? identifier(args.message_id,"消息 ID",/^om_[A-Za-z0-9_-]{8,100}$/) : null;
  const path = message ? `/im/v1/messages/${message}/resources/${token}?type=${kind === "message_image" ? "image" : "file"}` : `/drive/v1/${kind === "file" ? "files" : "medias"}/${token}/download`;
  return { token, kind: String(kind), message, path, scopes: message ? ["im:message:readonly","im:message.group_msg:get_as_user"] : ["drive:drive:readonly"] };
}

function allowedDownload(url: URL) {
  return url.protocol === "https:" && !url.username && !url.password && /^(?:[a-z0-9-]+\.)*(?:feishu\.cn|feishucdn\.com|larkoffice\.com|larksuite\.com|larksuitecdn\.com)$/i.test(url.hostname);
}
export async function resourceResponse(env: Runtime,user: string,args: Arguments): Promise<Response> {
  const params = resourceParameters(args), token = await accessToken(env,user,params.scopes);
  let response = await apiResponse(token,params.path);
  let redirected = false;
  for (let count=0; response.status >= 300 && response.status < 400; count++) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    let url: URL; try { url = new URL(location || ""); } catch { throw new AppError("provider_redirect","飞书未返回有效下载地址。",502); }
    if (count >= 2 || !allowedDownload(url)) throw new AppError("provider_redirect","下载跳转地址无法验证，已中止。",502);
    // Signed CDN destinations receive no application/user bearer credential.
    redirected = true;
    response = await fetch(url,{ redirect: "manual", signal: AbortSignal.timeout(20000) });
  }
  if (!response.ok) {
    let body: {code?:number} = {}; try { const parsed = JSON.parse(new TextDecoder().decode(await readLimited(response,65536))); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed; } catch { /* Missing/oversized error bodies do not hide the HTTP status. */ }
    // CDN failures are not the API's documented file-status response, and a
    // signed CDN URL must not be exposed as the diagnostic request path.
    providerError(response,body,redirected ? undefined : params.path,[token]);
  }
  return response;
}
export async function readLimited(response: Response,maximum: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (length > maximum) { await response.body?.cancel(); throw new AppError("resource_too_large","图片或附件超过本次读取大小上限，请使用下载工具。",413); }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("invalid_response","飞书未返回资源内容。",502);
  const chunks: Uint8Array[] = []; let total = 0;
  try { while(true) { const {done,value} = await reader.read(); if(done) break; total += value.byteLength; if(total > maximum) throw new AppError("resource_too_large","资源超过读取大小上限，请使用下载工具。",413); chunks.push(value); } }
  catch(error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(total); let offset=0; for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; } return bytes;
}
function imageMime(bytes: Uint8Array) {
  if (bytes.length >= 8 && bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71 && bytes[4]===13 && bytes[5]===10 && bytes[6]===26 && bytes[7]===10) return "image/png";
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return "image/jpeg";
  const prefix = new TextDecoder().decode(bytes.slice(0,12));
  if (/^GIF8[79]a/.test(prefix)) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8)==="WEBP") return "image/webp";
  throw new AppError("unsupported_image","此资源不是支持的图片格式，请使用下载工具。",400);
}
function base64(bytes: Uint8Array) { let value=""; for(let start=0;start<bytes.length;start+=8192) value+=String.fromCharCode(...bytes.slice(start,start+8192)); return btoa(value); }
export async function runResourceTool(env:Runtime,user:string,name:string,args:Arguments) {
  const params = resourceParameters(args), response = await resourceResponse(env,user,args);
  const url = new URL("/api/resource-download",env.SITE_ORIGIN);
  url.searchParams.set("resource_token",params.token); url.searchParams.set("kind",params.kind);
  if(params.message) url.searchParams.set("message_id",params.message);
  if(typeof args.file_name==="string") url.searchParams.set("file_name",args.file_name.slice(0,200));
  const result = { resource_token: params.token, kind: params.kind, content_type: response.headers.get("content-type"), download_url:url.toString(), requires_site_login:true };
  if(name === "feishu_read_image") {
    const bytes = await readLimited(response,5*1024*1024), mime = imageMime(bytes);
    return { ...result, size_bytes:bytes.length, _mcp_content:[{type:"image",data:base64(bytes),mimeType:mime}] };
  }
  await response.body?.cancel(); return result;
}
