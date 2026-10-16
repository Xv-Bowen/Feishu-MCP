import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import { assertMcpWireResponse } from "./mcp-wire-schema.mjs";

const directory = path.resolve(".sites-runtime/mcp-oauth-tests");
await mkdir(directory, { recursive: true });
for (const name of (await readdir("lib")).filter(name => name.endsWith(".ts")).map(name => name.slice(0,-3))) {
  const source = await readFile(`lib/${name}.ts`, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from "\.\/([A-Za-z0-9-]+)"/g, 'from "./$1.mjs"');
  await writeFile(`${directory}/${name}.mjs`, output);
}
const oauth = await import(pathToFileURL(`${directory}/mcp-oauth.mjs`));
const cipher = await import(pathToFileURL(`${directory}/crypto.mjs`));
const clients = await import(pathToFileURL(`${directory}/client-access.mjs`));
const feishu = await import(pathToFileURL(`${directory}/feishu.mjs`));
const core = await import(pathToFileURL(`${directory}/core.mjs`));
const features = await import(pathToFileURL(`${directory}/features.mjs`));
const sqlite = new DatabaseSync(":memory:");
for (const name of (await readdir("drizzle")).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(await readFile(`drizzle/${name}`, "utf8"));
const DB = {
  prepare(sql) {
    let bindings = [];
    return {
      bind(...values) { bindings = values; return this; },
      async first() { return sqlite.prepare(sql).get(...bindings) || null; },
      runNow() { return { meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } }; },
      async run() { return this.runNow(); },
    };
  },
  async batch(statements) {
    sqlite.exec("BEGIN");
    try { const results = statements.map(statement => statement.runNow()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
const env = { DB, SITE_ORIGIN: "https://connection.example", SITE_SERVICE_ACCESS: "synthetic-platform-access", FEISHU_APP_ID: "cli_synthetic", FEISHU_APP_SECRET: "synthetic-feishu-secret", TOKEN_ENCRYPTION_KEY: "a1".repeat(32) };
globalThis.__feishuOAuthTestEnv = env;
await writeFile(`${directory}/test-env.mjs`, "export const env = globalThis.__feishuOAuthTestEnv;");
for (const [file, name] of [["app/mcp/route.ts", "mcp"], ["app/api/client-mcp/route.ts", "client-mcp"], ["app/api/claude-oauth/[...path]/route.ts", "oauth-route"], ["app/.well-known/oauth-authorization-server/api/claude-oauth/route.ts", "issuer-route"], ["app/.well-known/oauth-protected-resource/api/client-mcp/route.ts", "resource-route"]]) {
  const source = await readFile(file, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from "cloudflare:workers"/g, 'from "./test-env.mjs"')
    .replace(/from "\.\.\/\.\.\/mcp\/route"/g, 'from "./mcp.mjs"')
    .replace(/from "(?:\.\.\/)+lib\/([A-Za-z0-9-]+)"/g, 'from "./$1.mjs"');
  await writeFile(`${directory}/${name}.mjs`, output);
}
const routes = await import(pathToFileURL(`${directory}/oauth-route.mjs`));
const mcp = await import(pathToFileURL(`${directory}/mcp.mjs`));
const external = await import(pathToFileURL(`${directory}/client-mcp.mjs`));
const issuerRoute = await import(pathToFileURL(`${directory}/issuer-route.mjs`));
const resourceRoute = await import(pathToFileURL(`${directory}/resource-route.mjs`));
const callback = "https://claude.ai/api/mcp/auth_callback";
const base = env.SITE_ORIGIN + "/api/claude-oauth";
const resource = env.SITE_ORIGIN + "/api/client-mcp";
const seconds = () => Math.floor(Date.now() / 1000);
const browserHeaders = user => ({ Origin: env.SITE_ORIGIN, "oai-authenticated-user-id": user });
const post = (endpoint, body, headers = {}, asJson = false) => routes.POST(new Request(base + endpoint, { method: "POST", headers: { "Content-Type": asJson ? "application/json" : "application/x-www-form-urlencoded", ...headers }, body: asJson ? JSON.stringify(body) : new URLSearchParams(body) }));
const rpc = async (route, method, params = {}, headers = {}) => {
  const response = await route.POST(new Request(resource, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const message = await response.clone().json();
  if (message.jsonrpc === "2.0") assertMcpWireResponse(message, method);
  return response;
};
async function register() {
  const response = await post("/register", { redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, {}, true);
  assert.equal(response.status, 201);
  return (await response.json()).client_id;
}
async function consent(user, client, scope = "feishu.read offline_access", extra = {}) {
  const verifier = cipher.randomString(64);
  const state = "opaque state + & 中文";
  const query = new URLSearchParams({ client_id: client, redirect_uri: callback, response_type: "code", code_challenge: await cipher.sha256(verifier), code_challenge_method: "S256", resource, scope, state, ...extra });
  const response = await routes.GET(new Request(base + "/authorize?" + query, { headers: { ...browserHeaders(user), "oai-authenticated-user-email": "<img src=x onerror=alert(1)>@example.test" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "same-origin", "Same-origin form POSTs must retain Origin while cross-origin callbacks receive no referrer");
  assert.ok(response.headers.get("content-security-policy").includes("form-action 'self' https://claude.ai"), "The consent form must allow its redirect back to Claude");
  const text = await response.text();
  assert.ok(text.includes("&lt;img") && !text.includes("<img"), "Consent must escape even verified display fields");
  assert.ok(text.includes(new URL(extra.redirect_uri || callback).hostname));
  assert.ok(!text.includes(env.SITE_SERVICE_ACCESS) && !text.includes(env.FEISHU_APP_SECRET), "Consent must not expose platform or provider credentials");
  const writing = !scope || scope.split(" ").includes("feishu.write");
  assert.equal(text.includes("允许读取和编辑"), writing, "The approval button must accurately describe the requested write authority");
  assert.equal(text.includes("创建、编辑或删除云空间文档及内容块，删除整份电子表格、多维表格、上传文件、幻灯片或文件夹，添加、回复、解决或删除评论及回复；按明确范围删除知识库节点和子节点"), writing);
  assert.equal(text.includes("创建或删除任务清单"), writing);
  assert.equal(text.includes("按要求邀请参会人"), writing);
  assert.equal(text.includes("删除工作表"), writing);
  assert.equal(text.includes("建立、执行、暂停或删除群聊检查规则"), writing);
  const requestId = text.match(/name="request_id" value="([^"]+)"/)[1];
  const csrf = text.match(/name="csrf_token" value="([^"]+)"/)[1];
  return { verifier, state, requestId, csrf };
}
async function approve(user, authorization, decision = "allow") {
  return post("/authorize", { request_id: authorization.requestId, csrf_token: authorization.csrf, decision }, browserHeaders(user));
}
async function codeFor(user, client, scope) {
  const authorization = await consent(user, client, scope);
  const approval = await approve(user, authorization);
  assert.equal(approval.status, 303);
  const url = new URL(approval.headers.get("location"));
  assert.equal(url.origin + url.pathname, callback);
  assert.equal(url.searchParams.get("state"), authorization.state);
  assert.equal(url.searchParams.get("iss"), base);
  return { code: url.searchParams.get("code"), code_verifier: authorization.verifier, client_id: client, redirect_uri: callback, resource, grant_type: "authorization_code" };
}
async function tokensFor(user, client, scope) {
  const response = await post("/token", await codeFor(user, client, scope));
  assert.equal(response.status, 200);
  return response.json();
}
const actualFetch = globalThis.fetch;
try {
  for (const [user, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
    sqlite.prepare("INSERT INTO feishu_connections (user_id, encrypted_tokens, expires_at, name, open_id, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(user, await cipher.seal({ access_token: "synthetic-" + user }, env.TOKEN_ENCRYPTION_KEY, user), seconds() + 3600, name, "ou_" + user, core.SCOPES.join(" "), seconds());
  }
  const discovery = await resourceRoute.GET();
  const document = await discovery.json();
  assert.equal(document.resource, resource);
  assert.deepEqual(document.authorization_servers, [base]);
  const metadata = await (await issuerRoute.GET()).json();
  assert.equal(metadata.issuer, base);
  assert.equal(metadata.registration_endpoint, base + "/register");
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(await (await routes.GET(new Request(base + "/.well-known/openid-configuration"))).json(), metadata);
  assert.equal((await routes.GET(new Request(base + "/nested/token"))).status, 404);
  assert.equal((await routes.GET(new Request(base + "/setup"))).status, 403);
  const setup = await (await routes.GET(new Request(base + "/setup", { headers: browserHeaders("alice") }))).json();
  assert.equal(setup.url, resource);
  assert.deepEqual(Object.keys(setup.headers), ["OAI-Sites-Authorization"], "OAuth setup must not pin an Authorization header");

  const missing = await rpc(external, "initialize", { protocolVersion: "2025-11-25" }, { "oai-authenticated-user-id": "alice" });
  assert.equal(missing.status, 401, "External requests cannot use a supplied identity header");
  assert.ok(missing.headers.get("www-authenticate").includes(base + "/resource"));
  assert.match(missing.headers.get("www-authenticate"), /scope="feishu.read feishu.write offline_access"/, "First connections must request the read/write consent required by this service's tools");
  for (const bad of ["https://attacker.example/callback", callback + "/", callback + "?other=1", "http://claude.ai/api/mcp/auth_callback"]) assert.equal((await post("/register", { redirect_uris: [bad] }, {}, true)).status, 400);
  assert.equal((await post("/register", { redirect_uris: [callback], token_endpoint_auth_method: "client_secret_basic" }, {}, true)).status, 400);
  assert.equal((await post("/register", { redirect_uris: [callback], grant_types: ["client_credentials"] }, {}, true)).status, 400);
  assert.equal((await post("/register", { redirect_uris: [callback] }, { Origin: "https://attacker.example" }, true)).status, 403);
  const aliceClient = await register();
  const bobClient = await register();
  const safari = await consent("alice", aliceClient);
  const safariBody = { request_id: safari.requestId, csrf_token: safari.csrf, decision: "allow" };
  const safariHeaders = { "oai-authenticated-user-id": "alice", Origin: "null", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
  for (const headers of [
    { ...safariHeaders, Origin: "https://attacker.example" },
    { ...safariHeaders, "Sec-Fetch-Site": "cross-site" },
    { ...safariHeaders, "Sec-Fetch-Site": "same-site" },
    { ...safariHeaders, "Sec-Fetch-Mode": "cors" },
    { ...safariHeaders, "Sec-Fetch-Dest": "iframe" },
    { "oai-authenticated-user-id": "alice", Origin: "null" },
    { Origin: "null", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
  ]) assert.equal((await post("/authorize", safariBody, headers)).status, 403, "Opaque Origin must not bypass signed-in identity or same-origin navigation checks");
  assert.equal((await post("/authorize", safariBody, { ...safariHeaders, "oai-authenticated-user-id": "bob" })).status, 400, "Opaque-origin consent stays bound to its signed-in user");
  assert.equal((await post("/authorize", { ...safariBody, csrf_token: "incorrect" }, safariHeaders)).status, 400, "Opaque-origin consent still requires its CSRF token");
  assert.equal((await post("/revoke-all", {}, safariHeaders)).status, 403, "Opaque-origin fallback must not apply to grant-management mutations");
  const safariApproval = await post("/authorize", safariBody, safariHeaders);
  assert.equal(safariApproval.status, 303, "Reproduce the observed iOS same-origin form POST with Origin: null");
  const safariCallback = new URL(safariApproval.headers.get("location"));
  assert.equal(safariCallback.origin + safariCallback.pathname, callback);
  assert.equal(safariCallback.searchParams.get("state"), safari.state);
  const safariTokens = await post("/token", { grant_type: "authorization_code", client_id: aliceClient, code: safariCallback.searchParams.get("code"), code_verifier: safari.verifier, redirect_uri: callback, resource });
  assert.equal(safariTokens.status, 200, "Opaque-origin consent must complete the PKCE code exchange");
  assert.equal(await oauth.oauthUser(env, "Bearer " + (await safariTokens.json()).access_token), "alice");
  assert.equal((await post("/authorize", safariBody, safariHeaders)).status, 400, "Opaque-origin consent remains one-use");
  const missingOrigin = await consent("alice", aliceClient);
  const { Origin: ignoredOrigin, ...navigationHeaders } = safariHeaders;
  assert.equal((await post("/authorize", { request_id: missingOrigin.requestId, csrf_token: missingOrigin.csrf, decision: "deny" }, navigationHeaders)).status, 303, "An app browser omitting Origin needs the same verified navigation and CSRF checks");
  const cancellation = await consent("alice", aliceClient);
  const denied = new URL((await approve("alice", cancellation, "deny")).headers.get("location"));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.has("code"), false);
  assert.equal(denied.searchParams.get("state"), cancellation.state);

  const auth = await consent("alice", aliceClient);
  assert.equal((await post("/authorize", { request_id: auth.requestId, csrf_token: auth.csrf, decision: "allow" }, { ...browserHeaders("alice"), Origin: "https://attacker.example" })).status, 403);
  assert.equal((await approve("bob", auth)).status, 400, "Another signed-in user cannot approve Alice's consent form");
  assert.equal((await approve("alice", { ...auth, csrf: "incorrect" })).status, 400);
  const approval = await approve("alice", auth);
  assert.equal(approval.status, 303);
  assert.equal((await approve("alice", auth)).status, 400, "Consent must be consumed once");
  const code = new URL(approval.headers.get("location")).searchParams.get("code");
  const exchange = { grant_type: "authorization_code", client_id: aliceClient, code, code_verifier: auth.verifier, redirect_uri: callback, resource };
  assert.equal((await post("/token", { ...exchange, code_verifier: cipher.randomString(64) })).status, 400);
  assert.equal((await post("/token", { ...exchange, client_id: bobClient })).status, 400);
  assert.equal((await post("/token", { ...exchange, resource: env.SITE_ORIGIN + "/mcp" })).status, 400);
  assert.equal((await post("/token", { ...exchange, redirect_uri: "https://attacker.example" })).status, 400);
  const tokenResponse = await post("/token", exchange);
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
  const alice = await tokenResponse.json();
  assert.equal(alice.token_type, "Bearer");
  assert.ok(alice.access_token && alice.refresh_token);
  assert.equal((await post("/token", exchange)).status, 400, "Authorization code cannot be exchanged twice");
  assert.equal(await oauth.oauthUser(env, "Bearer " + alice.access_token), "alice");
  const rows = JSON.stringify(sqlite.prepare("SELECT * FROM feishu_mcp_oauth_access").all()) + JSON.stringify(sqlite.prepare("SELECT * FROM feishu_mcp_oauth_refresh").all());
  assert.ok(!rows.includes(alice.access_token) && !rows.includes(alice.refresh_token), "Only token hashes may persist");
  const bob = await tokensFor("bob", bobClient);
  const noOffline = await tokensFor("alice", aliceClient, "feishu.read");
  assert.equal(noOffline.refresh_token, undefined, "Offline access requires explicit consent");
  const omittedScope = await tokensFor("alice", aliceClient, "");
  assert.equal(omittedScope.scope, "feishu.read feishu.write offline_access", "A new connector that omits scope must still show and record explicit read/write/offline consent");
  assert.ok(omittedScope.refresh_token);

  for (const protocolVersion of ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]) {
    const response = await rpc(external, "initialize", { protocolVersion }, { Authorization: "Bearer " + alice.access_token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.protocolVersion, protocolVersion);
  }
  const tools = await (await rpc(external, "tools/list", {}, { Authorization: "Bearer " + alice.access_token })).json();
  const modernMeta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "claude-protocol-fixture", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  for (const route of [external, mcp]) {
    for (const [method, params] of [["server/discover", {}], ["tools/list", {}], ["tools/call", { name: "feishu_connection_status" }]]) {
      const response = await rpc(route, method, { ...params, _meta: modernMeta }, { Authorization: "Bearer " + alice.access_token, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(params.name ? { "Mcp-Name": params.name } : {}) });
      assert.equal(response.status, 200);
      const message = await response.json();
      assert.equal(message.result.isError, undefined);
      if (method === "server/discover") assert.deepEqual(message.result.supportedVersions, ["2026-07-28"]);
      if (method !== "tools/call") {
        assert.equal(message.result.ttlMs, 0);
        assert.equal(message.result.cacheScope, "private");
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    }
  }
  // Prove the validator catches the exact regression, not only business output.
  const missingDiscriminator = structuredClone(tools);
  delete missingDiscriminator.result.resultType;
  assert.throws(() => assertMcpWireResponse(missingDiscriminator, "tools/list"), /resultType/);
  for (const field of ["ttlMs", "cacheScope"]) {
    const missingCacheHint = structuredClone(tools);
    delete missingCacheHint.result[field];
    assert.throws(() => assertMcpWireResponse(missingCacheHint, "tools/list"), new RegExp(field));
  }
  assert.deepEqual(tools.result.tools.map(tool => tool.name), clients.CLIENT_TOOLS);
  assert.equal(tools.result.tools.length, 91, "Existing read grants can discover writes without gaining permission to execute them");
  assert.equal(tools.result.tools.filter(tool => !tool.annotations.readOnlyHint).length, 43);
  for (const tool of tools.result.tools) {
    const required = ["feishu.read", ...(!tool.annotations.readOnlyHint ? ["feishu.write"] : [])];
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: required }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  }
  assert.ok(metadata.scopes_supported.includes("feishu.write"));
  assert.ok(document.scopes_supported.includes("feishu.write"));
  const aliceStatus = await (await rpc(external, "tools/call", { name: "feishu_connection_status" }, { Authorization: "Bearer " + alice.access_token, "oai-authenticated-user-id": "bob" })).json();
  assert.equal(aliceStatus.result.structuredContent.account_name, "Alice", "Token identity must override a forged caller identity");
  const chatGPT = await (await rpc(mcp, "tools/call", { name: "feishu_connection_status" }, { "oai-authenticated-user-id": "bob" })).json();
  assert.equal(chatGPT.result.structuredContent.account_name, "Bob", "ChatGPT's existing platform identity must still work");
  const legacy = await clients.issueClientKey(env, "alice");
  assert.equal((await rpc(external, "initialize", { protocolVersion: "2025-06-18" }, { Authorization: legacy.headers.Authorization })).status, 200);
  await clients.issueClientKey(env, "alice");
  assert.equal(await oauth.oauthUser(env, "Bearer " + alice.access_token), "alice", "Legacy key rotation cannot revoke OAuth");

  // A Feishu editor's old MCP read consent must never become a write grant.
  const editorScopes = features.selectedScopes(core.SCOPES, features.EXTRA_FEATURES.map(feature => feature.id));
  sqlite.prepare("UPDATE feishu_connections SET scope = ? WHERE user_id = 'alice'").run(editorScopes.join(" "));
  const legacyReader = await clients.issueClientKey(env, "alice");
  let providerWrites = 0;
  globalThis.fetch = async (url, options = {}) => {
    providerWrites++;
    assert.equal(String(url), "https://open.feishu.cn/open-apis/docx/v1/documents");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer synthetic-alice", "A caller cannot substitute another account for the write token");
    return Response.json({ code: 0, data: { document: { document_id: "DocumentWriteSynthetic", title: "Fixture" } } });
  };
  for (const name of clients.CLIENT_WRITE_TOOLS) {
    const deniedResponse = await rpc(external, "tools/call", { name, arguments: {} }, { Authorization: "Bearer " + alice.access_token });
    assert.equal(deniedResponse.status, 403, "OAuth step-up must use an HTTP 403, not only tool-result metadata");
    assert.match(deniedResponse.headers.get("www-authenticate"), /error="insufficient_scope"/);
    const denied = await deniedResponse.json();
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.error, "mcp_write_authorization_required");
    assert.match(denied.result._meta["mcp/www_authenticate"][0], /error="insufficient_scope"/);
    assert.match(denied.result._meta["mcp/www_authenticate"][0], /scope="feishu.read feishu.write"/);
    const legacyDenied = await (await rpc(external, "tools/call", { name, arguments: {} }, { Authorization: legacyReader.headers.Authorization })).json();
    assert.equal(legacyDenied.result.structuredContent.error, "mcp_write_authorization_required");
  }
  assert.equal(providerWrites, 0, "None of the denied tools may reach Feishu or create a write receipt");
  const oldStatus = await (await rpc(external, "tools/call", { name: "feishu_connection_status" }, { Authorization: "Bearer " + alice.access_token })).json();
  assert.equal(oldStatus.result.structuredContent.client_access.write_authorized, false);
  assert.equal(oldStatus.result.structuredContent.client_access.available_tool_count, 91);
  assert.equal(oldStatus.result.structuredContent.features.filter(feature => feature.ready).length, features.EXTRA_FEATURES.length);

  const editorConsent = await consent("alice", aliceClient, "feishu.read feishu.write offline_access");
  const savedRequest = sqlite.prepare("SELECT scope FROM feishu_mcp_oauth_requests WHERE request_hash = ?").get(await cipher.sha256(editorConsent.requestId));
  assert.equal(savedRequest.scope, "feishu.read feishu.write offline_access");
  const editorApproval = await approve("alice", editorConsent);
  const editorCode = new URL(editorApproval.headers.get("location")).searchParams.get("code");
  const editorResponse = await post("/token", { grant_type: "authorization_code", client_id: aliceClient, code: editorCode, code_verifier: editorConsent.verifier, redirect_uri: callback, resource });
  assert.equal(editorResponse.status, 200);
  const editor = await editorResponse.json();
  assert.equal(editor.scope, "feishu.read feishu.write offline_access");
  assert.ok((await oauth.oauthAccess(env, "Bearer " + editor.access_token)).scopes.includes("feishu.write"));
  const request = { name: "feishu_create_document", arguments: { title: "Fixture", request_id: "write-fixture-0001" } };
  sqlite.prepare("UPDATE feishu_connections SET scope = ? WHERE user_id = 'alice'").run(core.SCOPES.join(" "));
  const missingProviderScope = await (await rpc(external, "tools/call", request, { Authorization: "Bearer " + editor.access_token })).json();
  assert.equal(missingProviderScope.result.structuredContent.error, "additional_authorization_required", "MCP write consent cannot override missing Feishu edit permission");
  assert.equal(providerWrites, 0);
  sqlite.prepare("UPDATE feishu_connections SET scope = ? WHERE user_id = 'alice'").run(editorScopes.join(" "));
  const created = await (await rpc(external, "tools/call", request, { Authorization: "Bearer " + editor.access_token, "oai-authenticated-user-id": "bob" })).json();
  assert.equal(created.result.isError, undefined, JSON.stringify(created));
  assert.equal(providerWrites, 1);
  const repeated = await (await rpc(external, "tools/call", request, { Authorization: "Bearer " + editor.access_token })).json();
  assert.equal(repeated.result.structuredContent.replayed, true);
  assert.equal(providerWrites, 1, "The external write path must retain the existing encrypted idempotency ledger");
  const changed = await (await rpc(external, "tools/call", { ...request, arguments: { ...request.arguments, title: "Changed" } }, { Authorization: "Bearer " + editor.access_token })).json();
  assert.equal(changed.result.structuredContent.error, "request_conflict");
  assert.equal(providerWrites, 1);
  const editorStatus = await (await rpc(external, "tools/call", { name: "feishu_connection_status" }, { Authorization: "Bearer " + editor.access_token })).json();
  assert.equal(editorStatus.result.structuredContent.client_access.write_authorized, true);
  assert.equal(editorStatus.result.structuredContent.client_access.write_tool_count, 43);
  const forbidden = await (await rpc(external, "tools/call", { name: "feishu_send_message", arguments: {} }, { Authorization: "Bearer " + editor.access_token })).json();
  assert.equal(forbidden.result.structuredContent.error, "unknown_tool", "Write consent does not add bot or other unsupported actions");
  const editorRefresh = await post("/token", { grant_type: "refresh_token", client_id: aliceClient, refresh_token: editor.refresh_token, resource });
  assert.equal(editorRefresh.status, 200);
  assert.equal((await editorRefresh.json()).scope, editor.scope);
  globalThis.fetch = actualFetch;
  sqlite.prepare("UPDATE feishu_connections SET scope = ? WHERE user_id = 'alice'").run(core.SCOPES.join(" "));

  sqlite.prepare("UPDATE feishu_mcp_oauth_access SET expires_at = 0 WHERE key_hash = ?").run(await cipher.sha256(alice.access_token));
  assert.equal((await rpc(external, "ping", {}, { Authorization: "Bearer " + alice.access_token })).status, 401);
  const refresh = { grant_type: "refresh_token", refresh_token: alice.refresh_token, client_id: aliceClient, resource };
  assert.equal((await post("/token", { ...refresh, client_id: bobClient })).status, 400);
  assert.equal((await post("/token", { ...refresh, resource: env.SITE_ORIGIN + "/mcp" })).status, 400);
  assert.equal((await post("/token", { ...refresh, scope: "feishu.read write" })).status, 400);
  assert.equal((await post("/token", { ...refresh, scope: "feishu.read feishu.write offline_access" })).status, 400, "Refreshing an existing read grant cannot grant the newly supported write scope");
  const refreshedResponse = await post("/token", refresh);
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.notEqual(refreshed.refresh_token, alice.refresh_token);
  assert.equal(await oauth.oauthUser(env, "Bearer " + refreshed.access_token), "alice");
  assert.equal((await post("/token", refresh)).status, 400, "Refresh token cannot be reused");
  await assert.rejects(() => oauth.oauthUser(env, "Bearer " + refreshed.access_token), "Reuse must revoke the token family");
  assert.equal(await oauth.oauthUser(env, "Bearer " + bob.access_token), "bob", "Refresh reuse cannot affect another account");

  const concurrent = await tokensFor("alice", aliceClient);
  const concurrentRefresh = { grant_type: "refresh_token", refresh_token: concurrent.refresh_token, client_id: aliceClient, resource };
  const outcomes = await Promise.all([post("/token", concurrentRefresh), post("/token", concurrentRefresh)]);
  assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 400], "Concurrent refresh must not issue two successors");
  const winner = await outcomes.find(response => response.status === 200).json();
  await assert.rejects(() => oauth.oauthUser(env, "Bearer " + winner.access_token));
  const expiringCode = await codeFor("alice", aliceClient);
  sqlite.prepare("UPDATE feishu_mcp_oauth_codes SET expires_at = 0 WHERE code_hash = ?").run(await cipher.sha256(expiringCode.code));
  assert.equal((await post("/token", expiringCode)).status, 400);
  const expiringConsent = await consent("alice", aliceClient);
  sqlite.prepare("UPDATE feishu_mcp_oauth_requests SET expires_at = 0 WHERE request_hash = ?").run(await cipher.sha256(expiringConsent.requestId));
  assert.equal((await approve("alice", expiringConsent)).status, 400);

  const alive = await tokensFor("alice", aliceClient);
  assert.equal((await post("/revoke-all", {}, { ...browserHeaders("alice"), Origin: "https://attacker.example" })).status, 403);
  assert.equal((await post("/revoke-all", {}, browserHeaders("bob"))).status, 200);
  await assert.rejects(() => oauth.oauthUser(env, "Bearer " + bob.access_token));
  assert.equal(await oauth.oauthUser(env, "Bearer " + alive.access_token), "alice");
  const legacyAlive = await clients.issueClientKey(env, "alice");
  assert.equal((await post("/revoke-all", {}, browserHeaders("alice"))).status, 200);
  await assert.rejects(() => oauth.oauthUser(env, "Bearer " + alive.access_token));
  assert.equal(await clients.clientUser(env, legacyAlive.headers.Authorization), "alice");
  assert.equal((await feishu.status(env, "alice")).connected, true, "MCP grant revocation cannot disconnect Feishu or ChatGPT");

  const disconnected = await tokensFor("alice", aliceClient);
  await feishu.disconnect(env, "alice");
  await assert.rejects(() => oauth.oauthUser(env, "Bearer " + disconnected.access_token));
  assert.equal((await post("/token", { grant_type: "refresh_token", refresh_token: disconnected.refresh_token, client_id: aliceClient, resource })).status, 400);
  await assert.rejects(() => clients.clientUser(env, legacyAlive.headers.Authorization));
  assert.equal((await feishu.status(env, "alice")).connected, false);
  const badType = await post("/token", exchange, {}, true);
  assert.equal(badType.status, 415);

  // Inspect the actual discovery interface without leaking the service header.
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers["OAI-Sites-Authorization"], "Bearer " + env.SITE_SERVICE_ACCESS);
    assert.equal(options.redirect, "manual");
    return Response.json(String(url).endsWith("/resource") ? document : metadata);
  };
  const checks = await oauth.inspectOAuthDiscovery(env);
  assert.equal(checks.ready, true);
  assert.ok(!JSON.stringify(checks).includes(env.SITE_SERVICE_ACCESS));
  globalThis.fetch = async url => Response.json(String(url).includes("oauth-authorization-server") ? { issuer: "https://wrong-issuer.example" } : String(url).endsWith("/resource") ? document : metadata);
  assert.equal((await oauth.inspectOAuthDiscovery(env)).ready, false, "A hosting override returning a wrong issuer cannot be reported ready");
  env.CLIENT_OAUTH_ORIGIN = "https://gateway.example";
  const gatewayResource = env.CLIENT_OAUTH_ORIGIN + "/api/client-mcp";
  const gatewayIssuer = env.CLIENT_OAUTH_ORIGIN + "/api/claude-oauth";
  const gatewayMetadata = await (await oauth.authorizationServerMetadata(env)).json();
  assert.equal(gatewayMetadata.issuer, gatewayIssuer);
  assert.equal(gatewayMetadata.authorization_endpoint, base + "/authorize", "Browser login remains on the private original Site");
  const gatewaySetup = await (await routes.GET(new Request(base + "/setup", { headers: browserHeaders("bob") }))).json();
  assert.equal(gatewaySetup.url, gatewayResource);
  assert.deepEqual(gatewaySetup.headers, {}, "No platform credential may be returned for the public gateway");
  const gatewayConsent = await consent("bob", bobClient, "feishu.read offline_access", { resource: gatewayResource });
  const gatewayApproval = await approve("bob", gatewayConsent);
  const gatewayCallback = new URL(gatewayApproval.headers.get("location"));
  assert.equal(gatewayCallback.searchParams.get("iss"), gatewayIssuer);
  const gatewayTokensResponse = await post("/token", { grant_type: "authorization_code", client_id: bobClient, code: gatewayCallback.searchParams.get("code"), code_verifier: gatewayConsent.verifier, redirect_uri: callback, resource: gatewayResource });
  assert.equal(gatewayTokensResponse.status, 200);
  const gatewayTokens = await gatewayTokensResponse.json();
  assert.equal(await oauth.oauthUser(env, "Bearer " + gatewayTokens.access_token), "bob");
  const gatewayStatus = await (await rpc(external, "tools/call", { name: "feishu_connection_status" }, { Authorization: "Bearer " + gatewayTokens.access_token, "oai-authenticated-user-id": "alice" })).json();
  assert.equal(gatewayStatus.result.structuredContent.account_name, "Bob");
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith(env.CLIENT_OAUTH_ORIGIN + "/"));
    assert.equal(options.headers["OAI-Sites-Authorization"], undefined, "The original Site's platform credential must never be sent to a gateway");
    return String(url).endsWith("/resource") ? oauth.protectedResourceMetadata(env) : oauth.authorizationServerMetadata(env);
  };
  const publicChecks = await oauth.inspectOAuthDiscovery(env);
  assert.equal(publicChecks.ready, true);
  assert.equal(publicChecks.platform_header_required, false);
  const unchangedChatGPT = await (await rpc(mcp, "tools/call", { name: "feishu_connection_status" }, { "oai-authenticated-user-id": "bob" })).json();
  assert.equal(unchangedChatGPT.result.structuredContent.account_name, "Bob");
  // One public Site, one external MCP URL and a pre-registered manual client for both hosts.
  delete env.CLIENT_OAUTH_ORIGIN;
  env.CLIENT_MCP_PUBLIC = "true";
  env.MCP_OAUTH_CLIENT_ID = "fsoauth_synthetic_manual_client";
  const unified = env.SITE_ORIGIN + "/api/client-mcp";
  const chatgptCallback = "https://chatgpt.com/connector_platform_oauth_redirect";
  const unifiedRpc = (method, params = {}, headers = {}) => rpc({ POST: request => external.POST(new Request(unified, request)) }, method, params, headers);
  const unifiedMetadata = await (await oauth.authorizationServerMetadata(env)).json();
  assert.equal(unifiedMetadata.issuer, base);
  assert.equal(unifiedMetadata.authorization_response_iss_parameter_supported, true);
  assert.equal(unifiedMetadata.registration_endpoint, base + "/register", "Automatic registration must coexist with the owner's manual client");
  assert.equal(unifiedMetadata.client_id_metadata_document_supported, true);
  assert.equal((await post("/register", { redirect_uris: [callback] }, {}, true)).status, 201);
  const savedServiceAccess = env.SITE_SERVICE_ACCESS;
  delete env.SITE_SERVICE_ACCESS;
  const unifiedSetup = await (await routes.GET(new Request(base + "/setup", { headers: browserHeaders("bob") }))).json();
  assert.equal(unifiedSetup.url, unified);
  assert.equal(unifiedSetup.client_id, env.MCP_OAUTH_CLIENT_ID);
  assert.equal(unifiedSetup.oauth_client, "automatic");
  assert.deepEqual(unifiedSetup.oauth_client_methods, ["client_id_metadata_document", "dynamic_registration", "manual"]);
  assert.deepEqual(unifiedSetup.headers, {});
  assert.deepEqual(unifiedSetup.redirect_uris, [callback, chatgptCallback]);
  assert.ok(!JSON.stringify(unifiedSetup).includes(savedServiceAccess));
  const fixedPublic = await clients.issueClientKey(env, "bob");
  assert.equal(fixedPublic.url, unified);
  assert.deepEqual(Object.keys(fixedPublic.headers), ["Authorization"], "The public project must never give callers its platform access credential");
  assert.equal((await external.GET()).status, 401);
  const unauthenticated = await unifiedRpc("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(unauthenticated.status, 401);
  assert.ok(unauthenticated.headers.get("www-authenticate").includes(base + "/resource"));
  assert.equal((await unifiedRpc("tools/call", { name: "feishu_connection_status" })).status, 401);
  assert.equal((await unifiedRpc("tools/call", { name: "feishu_read_document", arguments: { document: "https://my.feishu.cn/docx/AAAAAAAAAAAAAAAAAAAAAAAAAAA" } })).status, 401);
  assert.equal((await unifiedRpc("server/discover")).status, 401, "External discovery still requires a user grant");
  const schema = await (await rpc(mcp, "tools/list")).json();
  assert.equal(schema.result.tools.length, 91);
  assert.ok(schema.result.tools.every(tool => tool.icons[0].src === env.SITE_ORIGIN + "/feishu-icon.png"));
  const nativePublic = await (await rpc(mcp, "tools/call", { name: "feishu_connection_status" }, browserHeaders("bob"))).json();
  assert.equal(nativePublic.result.structuredContent.account_name, "Bob", "The existing ChatGPT platform connection remains compatible");
  const fixedPublicStatus = await (await unifiedRpc("tools/call", { name: "feishu_connection_status" }, { Authorization: fixedPublic.headers.Authorization, ...browserHeaders("alice") })).json();
  assert.equal(fixedPublicStatus.result.structuredContent.account_name, "Bob");
  assert.equal((await unifiedRpc("initialize", {}, { Authorization: "Bearer " + gatewayTokens.access_token })).status, 401, "Tokens for the retired gateway cannot cross to the new resource");
  for (const targetCallback of [callback, chatgptCallback]) {
    const authorization = await consent("bob", env.MCP_OAUTH_CLIENT_ID, "feishu.read offline_access", { resource: unified, redirect_uri: targetCallback });
    const approval = await approve("bob", authorization);
    assert.equal(approval.status, 303);
    const redirect = new URL(approval.headers.get("location"));
    assert.equal(redirect.origin + redirect.pathname, targetCallback);
    assert.equal(redirect.searchParams.get("iss"), base);
    assert.equal(redirect.searchParams.get("state"), authorization.state);
    const exchange = { grant_type: "authorization_code", client_id: env.MCP_OAUTH_CLIENT_ID, code: redirect.searchParams.get("code"), code_verifier: authorization.verifier, redirect_uri: targetCallback, resource: unified };
    assert.equal((await post("/token", { ...exchange, redirect_uri: targetCallback === callback ? chatgptCallback : callback })).status, 400, "Code binding must prevent callback substitution between hosts");
    const response = await post("/token", exchange);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    const initialized = await (await unifiedRpc("initialize", { protocolVersion: "2025-11-25" }, { Authorization: "Bearer " + tokens.access_token })).json();
    assert.equal(initialized.result.serverInfo.websiteUrl, env.SITE_ORIGIN);
    assert.equal(initialized.result.serverInfo.icons[0].src, env.SITE_ORIGIN + "/feishu-icon.png");
    const result = await (await unifiedRpc("tools/call", { name: "feishu_connection_status" }, { Authorization: "Bearer " + tokens.access_token, ...browserHeaders("alice") })).json();
    assert.equal(result.result.structuredContent.account_name, "Bob", "Verified OAuth identity wins over an unrelated browser session");
    const refreshed = await post("/token", { grant_type: "refresh_token", client_id: env.MCP_OAUTH_CLIENT_ID, refresh_token: tokens.refresh_token, resource: unified });
    assert.equal(refreshed.status, 200);
    assert.equal(await oauth.oauthUser(env, "Bearer " + (await refreshed.json()).access_token), "bob");
  }
  for (const badCallback of [chatgptCallback + "/", callback + "?extra=1", "https://chatgpt.com.evil.example/connector_platform_oauth_redirect", "https://claude.ai.evil.example/api/mcp/auth_callback"]) {
    const query = new URLSearchParams({ client_id: env.MCP_OAUTH_CLIENT_ID, redirect_uri: badCallback, response_type: "code", code_challenge: await cipher.sha256(cipher.randomString(64)), code_challenge_method: "S256", resource: unified });
    assert.equal((await routes.GET(new Request(base + "/authorize?" + query, { headers: browserHeaders("bob") }))).status, 400);
  }
  // Enabling automatic choices must not invalidate clients registered before
  // the owner's manual ID was configured.
  assert.equal(await oauth.oauthUser(env, "Bearer " + (await tokensFor("bob", bobClient)).access_token), "bob");
  async function automaticFlow(clientId, redirectUri) {
    const authorization = await consent("bob", clientId, "feishu.read feishu.write offline_access", { redirect_uri: redirectUri });
    const approval = await approve("bob", authorization);
    assert.equal(approval.status, 303);
    const target = new URL(approval.headers.get("location"));
    assert.equal(target.origin + target.pathname, redirectUri);
    assert.equal(target.searchParams.get("iss"), base);
    assert.equal(target.searchParams.get("state"), authorization.state);
    const exchange = { grant_type: "authorization_code", client_id: clientId, code: target.searchParams.get("code"), code_verifier: authorization.verifier, redirect_uri: redirectUri, resource };
    assert.equal((await post("/token", { ...exchange, client_id: env.MCP_OAUTH_CLIENT_ID })).status, 400, "Automatic codes remain bound to their own client identity");
    const response = await post("/token", exchange);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.equal(await oauth.oauthUser(env, "Bearer " + tokens.access_token), "bob");
    const access = await oauth.oauthAccess(env, "Bearer " + tokens.access_token);
    assert.deepEqual(access.scopes, ["feishu.read", "feishu.write", "offline_access"]);
    const refreshed = await post("/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token, resource });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).scope, "feishu.read feishu.write offline_access");
  }
  const specificCallback = "https://chatgpt.com/connector/oauth/" + "X".repeat(120);
  for (const redirectUri of [chatgptCallback, specificCallback]) {
    const registration = await post("/register", { redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }, {}, true);
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.equal(registered.client_name, "ChatGPT");
    assert.deepEqual(registered.redirect_uris, [redirectUri]);
    await automaticFlow(registered.client_id, redirectUri);
    const query = new URLSearchParams({ client_id: registered.client_id, redirect_uri: redirectUri === chatgptCallback ? specificCallback : chatgptCallback });
    assert.equal((await routes.GET(new Request(base + "/authorize?" + query, { headers: browserHeaders("bob") }))).status, 400, "DCR binds an exact callback, even between two official ChatGPT addresses");
  }
  for (const redirectUri of [specificCallback + "?next=https://attacker.example", specificCallback + "/", "https://chatgpt.com:443/connector/oauth/ok", "https://chatgpt.com/connector/oauth/%2Fattacker", "https://chatgpt.com@attacker.example/connector/oauth/ok"]) {
    assert.equal((await post("/register", { redirect_uris: [redirectUri] }, {}, true)).status, 400, "Only literal official callbacks may register");
  }
  const clientDocument = (clientId, redirectUri) => ({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], token_endpoint_auth_method: "private_key_jwt" });
  let metadataFetches = 0;
  for (const [clientId, redirectUri] of [["https://claude.ai/oauth/mcp-oauth-client-metadata", callback], ["https://chatgpt.com/oauth/client.json", chatgptCallback], ["https://chatgpt.com/oauth/" + "X".repeat(120) + "/client.json", specificCallback]]) {
    globalThis.fetch = async (url, options) => {
      metadataFetches++;
      assert.equal(String(url), clientId);
      assert.deepEqual(options.headers, { Accept: "application/json" }, "CIMD fetch must not send provider, platform or user credentials");
      assert.equal(options.redirect, "manual", "CIMD must never follow an untrusted redirect");
      return Response.json(clientDocument(clientId, redirectUri));
    };
    const countBefore = sqlite.prepare("SELECT COUNT(*) AS n FROM feishu_mcp_oauth_clients").get().n;
    await automaticFlow(clientId, redirectUri);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM feishu_mcp_oauth_clients").get().n, countBefore, "CIMD identifies clients without creating registration records");
    const denied = new URL((await approve("bob", await consent("bob", clientId, "feishu.read", { redirect_uri: redirectUri }), "deny")).headers.get("location"));
    assert.equal(denied.searchParams.get("error"), "access_denied");
    assert.equal(denied.searchParams.get("iss"), base);
  }
  const claudeId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  globalThis.fetch = async () => Response.json({ client_id: claudeId, redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"] });
  await automaticFlow(claudeId, callback);
  globalThis.fetch = async () => new Response(null, { status: 403 });
  const unavailable = await routes.GET(new Request(base + "/authorize?" + new URLSearchParams({ client_id: claudeId, redirect_uri: callback })));
  assert.equal(unavailable.status, 503);
  assert.ok((await unavailable.text()).includes("自动注册"));
  const metadataCalls = metadataFetches;
  for (const clientId of ["http://chatgpt.com/oauth/client.json", "https://chatgpt.com.evil.example/oauth/client.json", "https://attacker.example/client.json", "https://127.0.0.1/client.json", "https://chatgpt.com/oauth/client.json?other=1", "https://chatgpt.com/oauth/client.json#fragment", "https://chatgpt.com:443/oauth/client.json", "https://user@chatgpt.com/oauth/client.json", "https://claude.ai.evil.example/oauth/mcp-oauth-client-metadata", "https://claude.ai/oauth/mcp-oauth-client-metadata?next=1", "https://claude.ai/oauth/unknown-metadata"]) {
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: chatgptCallback });
    assert.equal((await routes.GET(new Request(base + "/authorize?" + query, { headers: browserHeaders("bob") }))).status, 400);
  }
  assert.equal(metadataFetches, metadataCalls, "Untrusted CIMD URLs must fail before any outgoing request");
  async function rejectedMetadata(responseFactory, redirectUri = chatgptCallback, expectedStatus = 400) {
    globalThis.fetch = responseFactory;
    const query = new URLSearchParams({ client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: redirectUri });
    assert.equal((await routes.GET(new Request(base + "/authorize?" + query, { headers: browserHeaders("bob") }))).status, expectedStatus);
  }
  const validDocument = clientDocument("https://chatgpt.com/oauth/client.json", chatgptCallback);
  for (const document of [{ ...validDocument, client_id: "https://attacker.example/client.json" }, { ...validDocument, redirect_uris: [specificCallback] }, { ...validDocument, token_endpoint_auth_methods_supported: ["private_key_jwt"] }, { ...validDocument, token_endpoint_auth_methods_supported: "none" }, []]) {
    await rejectedMetadata(async () => Response.json(document));
  }
  await rejectedMetadata(async () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/" } }));
  await rejectedMetadata(async () => new Response("{}", { headers: { "Content-Type": "text/html" } }));
  await rejectedMetadata(async () => new Response("{broken", { headers: { "Content-Type": "application/json" } }));
  await rejectedMetadata(async () => new Response("x".repeat(32769), { headers: { "Content-Type": "application/json" } }));
  await rejectedMetadata(async () => { throw new Error("synthetic timeout"); }, chatgptCallback, 503);
  await rejectedMetadata(async () => { throw new Error("Callback mismatch must be rejected before fetching"); }, specificCallback);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers?.["OAI-Sites-Authorization"], undefined);
    if (String(url).endsWith("/feishu-icon.png")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    if (String(url) === unified) return external.POST(new Request(url, options));
    return String(url).endsWith("/resource") ? oauth.protectedResourceMetadata(env) : oauth.authorizationServerMetadata(env);
  };
  const unifiedChecks = await oauth.inspectOAuthDiscovery(env);
  assert.equal(unifiedChecks.ready, true);
  assert.equal(unifiedChecks.oauth_client, "automatic");
  assert.deepEqual(unifiedChecks.oauth_client_methods, unifiedSetup.oauth_client_methods);
  assert.deepEqual(unifiedChecks.mcp_challenge, { status: 401, valid: true });
  assert.equal(unifiedChecks.platform_header_required, false);
  assert.equal(unifiedChecks.icon.valid, true);
  env.SITE_SERVICE_ACCESS = savedServiceAccess;
  console.log("PASS: automatic CIMD and DCR alongside old manual/registered clients; exact callbacks, PKCE, consent, issuer, scope-preserving refresh, official metadata validation and blocked SSRF/redirects/oversize documents");
  console.log("PASS: 91 external tools, 43 scoped writes, old-read and fixed-key write denial, separate Feishu permissions, OAuth step-up challenges, encrypted write replay and scope-preserving refresh; unified URL and manual client ID");
  console.log("PASS: official MCP 2026-07-28 and 2025-11-25 wire schemas; modern discovery, cache fields, tool success/errors and OAuth step-up; missing resultType/cache fields rejected");
  console.log("PASS: MCP OAuth discovery, Claude callback restrictions, explicit consent, CSRF, PKCE, one-time codes, token hashing, refresh rotation/reuse/concurrency, account isolation, expiry/revocation, ChatGPT compatibility and legacy client compatibility");
} finally { globalThis.fetch = actualFetch; delete globalThis.__feishuOAuthTestEnv; sqlite.close(); await rm(directory, { recursive: true, force: true }); }
