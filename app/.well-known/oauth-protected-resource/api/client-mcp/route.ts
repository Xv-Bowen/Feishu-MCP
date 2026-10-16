import { env } from "cloudflare:workers";
import { protectedResourceMetadata } from "../../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";
export const GET = () => protectedResourceMetadata(env);
