import { CLIENT_TOOLS, CLIENT_READ_TOOLS, CLIENT_WRITE_TOOLS, clientUser } from "./client-access";
import { AppError, safeMessage } from "./core";
import { oauthChallenge, oauthAccess, oauthBearerChallenge, publicClientMcp, type OAuthContext } from "./mcp-oauth";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, type McpClientAccess } from "./client-permissions";
import { completeMcpResult } from "./mcp-protocol";

// External callers establish account identity only through a verified token.
// The shared processor is internal; no forwarded caller identity is retained.
export async function handleClientMcp(env: OAuthContext, request: Request, processor: (request: Request) => Promise<Response>): Promise<Response> {
  let id: unknown = null;
  const complete = <T extends object & { _meta?: Record<string, unknown> }>(result: T) => completeMcpResult(result, publicClientMcp(env) ? env.SITE_ORIGIN : undefined);
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) return oauthChallenge(env);
    let access: McpClientAccess;
    try { access = authorization.startsWith("Bearer fsmcp_at_") ? await oauthAccess(env, authorization) : { user_id: await clientUser(env, authorization), scopes: [MCP_READ_SCOPE], authentication: "api_key" }; }
    catch (error) { if (error instanceof AppError && error.status === 401) return oauthChallenge(env, true); throw error; }
    const body = await request.text();
    if (body.length > 6 * 1024 * 1024) return Response.json({ error: "Request too large" }, { status: 413 });
    const message = JSON.parse(body) as { id?: unknown; method?: string; params?: { name?: string } };
    id = message?.id ?? null;
    if (message?.method === "tools/call") {
      const name = message.params?.name || "";
      if (!CLIENT_TOOLS.includes(name)) throw new AppError("unknown_tool", "该客户端入口不提供此工具。");
      if (CLIENT_WRITE_TOOLS.includes(name) && !access.scopes.includes(MCP_WRITE_SCOPE)) {
        const oauth = access.authentication === "oauth";
        const challenge = oauthBearerChallenge(env, "insufficient_scope");
        const details = { error: "mcp_write_authorization_required", message: oauth ? "当前 MCP 连接只有读取许可。请在 Claude 或 ChatGPT 的连接器设置中重新连接本服务，并在授权页确认「允许读取和编辑」；已有飞书功能授权会保留。" : "固定客户端凭据仅允许读取。请使用 OAuth 连接并明确批准 feishu.write 写入许可。", required_scopes: [MCP_READ_SCOPE, MCP_WRITE_SCOPE], reconnect_required: oauth, connection_url: env.SITE_ORIGIN };
        // MCP clients such as Claude use the transport-level 403 challenge for
        // step-up. Preserve the tool-result metadata for hosts that use it.
        return Response.json({ jsonrpc: "2.0", id, result: complete({ isError: true, content: [{ type: "text", text: JSON.stringify(details) }], structuredContent: details, ...(oauth ? { _meta: { "mcp/www_authenticate": [challenge] } } : {}) }) }, { status: oauth ? 403 : 200, headers: { "Cache-Control": "no-store", ...(oauth ? { "WWW-Authenticate": challenge } : {}) } });
      }
    }
    const response = await processor(new Request(`${env.SITE_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "oai-authenticated-user-id": access.user_id }, body }));
    if (message?.method === "tools/list" || (message?.method === "tools/call" && message.params?.name === "feishu_connection_status")) {
      const data = await response.json() as { result?: { tools?: Array<{ name: string; [key: string]: unknown }>; structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> } };
      if (data.result?.tools) data.result.tools = data.result.tools.filter(tool => CLIENT_TOOLS.includes(tool.name)).map(tool => {
        const securitySchemes = [{ type: "oauth2", scopes: [MCP_READ_SCOPE, ...(CLIENT_WRITE_TOOLS.includes(tool.name) ? [MCP_WRITE_SCOPE] : [])] }];
        return { ...tool, securitySchemes, _meta: { ...(tool._meta as Record<string, unknown> || {}), securitySchemes } };
      });
      if (data.result?.structuredContent) {
        data.result.structuredContent.client_access = { authentication: access.authentication, scopes: access.scopes, write_authorized: access.scopes.includes(MCP_WRITE_SCOPE), available_tool_count: CLIENT_TOOLS.length, read_tool_count: CLIENT_READ_TOOLS.length, write_tool_count: CLIENT_WRITE_TOOLS.length };
        const block = data.result.content?.find(item => item.type === "text");
        if (block) block.text = JSON.stringify(data.result.structuredContent);
      }
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    }
    return response;
  } catch (error) {
    const details = { error: error instanceof AppError ? error.kind : "invalid_request", message: safeMessage(error), connection_url: env.SITE_ORIGIN };
    return Response.json({ jsonrpc: "2.0", id, result: complete({ isError: true, content: [{ type: "text", text: JSON.stringify(details) }], structuredContent: details }) }, { headers: { "Cache-Control": "no-store" } });
  }
}
