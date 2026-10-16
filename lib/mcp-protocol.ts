import { serverInfo } from "./branding";

// These fields belong to the MCP wire result, including tool-level errors.
// Older MCP clients tolerate them; 2026-07-28 clients require resultType.
export function completeMcpResult<T extends object & { _meta?: Record<string, unknown> }>(result: T, origin?: string) {
  return {
    ...result,
    resultType: "complete" as const,
    _meta: { ...result._meta, "io.modelcontextprotocol/serverInfo": serverInfo(origin) },
  };
}

// Tool visibility and authorization metadata can depend on the current grant.
// Do not reuse discovery/list responses across users or cache stale permissions.
export const MCP_CACHE_HINTS = { ttlMs: 0, cacheScope: "private" as const };
