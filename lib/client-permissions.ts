export const MCP_READ_SCOPE = "feishu.read";
export const MCP_WRITE_SCOPE = "feishu.write";
export const MCP_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE, "offline_access"];

export type McpClientAccess = {
  user_id: string;
  scopes: string[];
  authentication: "oauth" | "api_key";
};
