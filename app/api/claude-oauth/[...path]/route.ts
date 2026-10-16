import { env } from "cloudflare:workers";
import { handleOAuthGet, handleOAuthPost } from "../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleOAuthGet(env, request);
export const POST = (request: Request) => handleOAuthPost(env, request);
