import { env } from "cloudflare:workers";
import { handleMcp } from "../../mcp/route";
import { handleClientMcp } from "../../../lib/mcp-client";
import { oauthChallenge } from "../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";
export async function GET() { return oauthChallenge(env); }
export async function POST(request: Request) {
  // Canonical manual-client URL; reuse the existing account-scoped processor.
  return handleClientMcp(env, request, handleMcp);
}
