import { env } from "cloudflare:workers";
import { AppError, safeMessage } from "../../../lib/core";
import { resourceResponse } from "../../../lib/resources";
export const dynamic = "force-dynamic";
export async function GET(request:Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if(!user) return Response.json({error:"请登录连接页面后下载。"},{status:401,headers:{"Cache-Control":"no-store"}});
  try {
    const args = Object.fromEntries(new URL(request.url).searchParams);
    const response = await resourceResponse(env,user,args), maximum=64*1024*1024;
    if(Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new AppError("resource_too_large","本站下载上限为 64 MB，请在飞书原页面下载此文件。",413); }
    let size=0;
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){size+=chunk.byteLength;if(size>maximum)controller.error(new Error("Download size limit"));else controller.enqueue(chunk);}}));
    const filename = (args.file_name || "feishu-resource").replace(/[\r\n\0/\\]/g,"_").slice(0,200);
    return new Response(body,{headers:{"Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename="feishu-resource"; filename*=UTF-8''${encodeURIComponent(filename)}`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'"}});
  } catch(error) { return Response.json({error:error instanceof AppError?error.kind:"download_failed",message:safeMessage(error)},{status:error instanceof AppError?error.status:503,headers:{"Cache-Control":"no-store"}}); }
}
