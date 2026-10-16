import { env } from "cloudflare:workers";
import { authorizationServerMetadata } from "../../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";
export const GET = () => authorizationServerMetadata(env);
