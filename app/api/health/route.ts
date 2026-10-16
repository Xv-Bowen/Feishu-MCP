import { env } from "cloudflare:workers";
import { randomString, seal, unseal } from "../../../lib/crypto";
import { configuration, finishAuthorization, startAuthorization } from "../../../lib/feishu";
import { AppError, diagnosticMessage } from "../../../lib/core";
export const dynamic = "force-dynamic";

// The owner-private Sites access boundary protects this read-only check.
// Return readiness flags only; never return credentials or account records.
export async function GET(request?: Request) {
  if (env.CLIENT_MCP_PUBLIC === "true" && !request?.headers.get("oai-authenticated-user-id")) return new Response(null, { status: 401 });
  const checks: Record<string, boolean> = { configuration: configuration(env).configured, encryption_key_format: /^[0-9a-f]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY || "") };
  if (checks.encryption_key_format) {
    try { checks.encryption = await unseal(await seal("self-test", env.TOKEN_ENCRYPTION_KEY!, "self-test"), env.TOKEN_ENCRYPTION_KEY!, "self-test") === "self-test"; }
    catch { checks.encryption = false; }
  } else checks.encryption = false;
  for (const table of ["feishu_connections", "feishu_oauth_states", "feishu_client_keys"]) {
    try { await env.DB!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(); checks[table] = true; }
    catch { checks[table] = false; }
  }
  const ok = Object.values(checks).every(Boolean);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

// Exercise the exact state-generation path using an isolated temporary owner.
// A deliberately invalid code checks the provider transport without creating
// a real account connection; all temporary authorization state is removed.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (env.CLIENT_MCP_PUBLIC === "true" && (!request.headers.get("oai-authenticated-user-id") || origin !== env.SITE_ORIGIN)) return new Response(null, { status: 403 });
  if (origin && origin !== env.SITE_ORIGIN) return new Response(null, { status: 403 });
  const response = await GET(request);
  const report = await response.json() as { ok: boolean; checks: Record<string, boolean>; error_kind?: string; diagnostic_error?: string; provider_error?: string };
  if (!report.ok) return Response.json(report, { status: 503, headers: { "Cache-Control": "no-store" } });
  const owner = `self-test:${randomString(18)}`;
  const invalidCode = `diagnostic-invalid-${randomString(32)}`;
  let state: string | null = null;
  try {
    const authorization = await startAuthorization(env, owner);
    state = new URL(authorization).searchParams.get("state");
    const redirect = new Response(null, { status: 303, headers: { Location: authorization } });
    report.checks.authorization_state = redirect.status === 303;
    // An invalid code must be rejected by Feishu. This exercises native state
    // consumption, decryption and the provider request without a real account.
    try {
      await finishAuthorization(env, owner, invalidCode, state, false);
      report.checks.oauth_callback = false;
    } catch (error) {
      const rejectedCode = error instanceof AppError && ["oauth_error", "reauthorization_required"].includes(error.kind) && /20003|20004|20065/.test(error.message);
      report.checks.oauth_callback = rejectedCode;
      if (error instanceof AppError) report.provider_error = error.kind;
      if (!rejectedCode) throw error;
    }
  } catch (error) {
    report.checks.oauth_callback = false;
    report.error_kind = error instanceof AppError ? error.kind : error instanceof Error ? error.name : "unknown";
    report.diagnostic_error = diagnosticMessage(error, [env.FEISHU_APP_SECRET, env.TOKEN_ENCRYPTION_KEY, owner, invalidCode, state]);
  } finally {
    await env.DB!.prepare("DELETE FROM feishu_oauth_states WHERE user_id = ?").bind(owner).run();
  }
  report.ok = Object.values(report.checks).every(Boolean);
  return Response.json(report, { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
