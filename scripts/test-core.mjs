import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import { runWithExecutionContext } from "vinext/shims/request-context";

const directory = path.resolve(".sites-runtime/contract-tests");
await mkdir(directory, { recursive: true });
for (const name of (await readdir("lib")).filter(name => name.endsWith(".ts")).map(name => name.slice(0,-3))) {
  const source = await readFile(`lib/${name}.ts`, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from "\.\/([A-Za-z0-9-]+)"/g, 'from "./$1.mjs"');
  await writeFile(`${directory}/${name}.mjs`, output);
}
const core = await import(pathToFileURL(`${directory}/core.mjs`));
const cipher = await import(pathToFileURL(`${directory}/crypto.mjs`));
const feishu = await import(pathToFileURL(`${directory}/feishu.mjs`));
const clients = await import(pathToFileURL(`${directory}/client-access.mjs`));
const chat = await import(pathToFileURL(`${directory}/chat.mjs`));
const actualFetch = globalThis.fetch;
const sqlite = new DatabaseSync(":memory:");
for (const name of (await readdir("drizzle")).filter(x => x.endsWith(".sql"))) sqlite.exec(await readFile(`drizzle/${name}`, "utf8"));
const databaseQueries = [];
const DB = {
  prepare(sql) {
    let bindings = [];
    return {
      bind(...values) { bindings = values; return this; },
      async first() { databaseQueries.push(sql); return sqlite.prepare(sql).get(...bindings) || null; },
      async run() { databaseQueries.push(sql); return { meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } }; },
    };
  },
  async batch(statements) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
const env = { DB, FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "synthetic-test-secret", SITE_ORIGIN: "https://connection.example", SITE_SERVICE_ACCESS: "synthetic-site-access", TOKEN_ENCRYPTION_KEY: "a1".repeat(32) };
globalThis.__feishuTestEnv = env;
await writeFile(`${directory}/test-env.mjs`, "export const env = globalThis.__feishuTestEnv;");
for (const [file, outputName] of [["app/mcp/route.ts", "mcp"], ["app/api/client-mcp/route.ts", "client-mcp"], ["app/api/client-keys/route.ts", "client-keys"], ["app/api/health/route.ts", "health"], ["app/api/test-read/route.ts", "test-read"], ["app/api/test-chats/route.ts", "test-chats"]]) {
  const source = await readFile(file, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from "cloudflare:workers"/g, 'from "./test-env.mjs"')
    .replace(/from "\.\.\/\.\.\/mcp\/route"/g, 'from "./mcp.mjs"')
    .replace(/from "(?:\.\.\/)+lib\/([A-Za-z0-9-]+)"/g, 'from "./$1.mjs"');
  await writeFile(`${directory}/${outputName}.mjs`, output);
}
const clientRoute = await import(pathToFileURL(`${directory}/client-mcp.mjs`));
const keyRoute = await import(pathToFileURL(`${directory}/client-keys.mjs`));
const healthRoute = await import(pathToFileURL(`${directory}/health.mjs`));
const readTestRoute = await import(pathToFileURL(`${directory}/test-read.mjs`));
const chatTestRoute = await import(pathToFileURL(`${directory}/test-chats.mjs`));
const clientRpc = async (method, params, authorization, identity = "mallory") => (await clientRoute.POST(new Request(env.SITE_ORIGIN + "/api/client-mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}), "oai-authenticated-user-id": identity }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }))).json();
let calls = [];
try {
  const id = "AAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(core.documentId("https://my.feishu.cn/docx/AAAAAAAAAAAAAAAAAAAAAAAAAAA" + "#heading"), id);
  assert.equal(core.documentId(id), id);
  for (const input of ["https://feishu.cn.evil.example/docx/" + id, "https://evil.example/docx/" + id, "http://my.feishu.cn/docx/" + id, "https://user:pass@my.feishu.cn/docx/" + id, "https://my.feishu.cn/wiki/" + id, "../../etc/passwd"]) assert.throws(() => core.documentId(input));
  assert.throws(() => core.searchParameters({ query: "x", offset: 190, limit: 10 }));
  assert.throws(() => core.searchParameters({ query: " ", limit: 10 }));
  assert.throws(() => core.documentChunk("x", { offset: -1 }));
  const text = "飞书文档".repeat(13000);
  let all = "", offset = 0;
  do { const chunk = core.documentChunk(text, { offset, max_characters: 10000 }); all += chunk.content; offset = chunk.next_offset; } while (offset !== null);
  assert.equal(all, text);
  const encrypted = await cipher.seal({ access_token: "synthetic-access" }, env.TOKEN_ENCRYPTION_KEY, "alice");
  assert.ok(!encrypted.includes("synthetic-access"));
  assert.equal((await cipher.unseal(encrypted, env.TOKEN_ENCRYPTION_KEY, "alice")).access_token, "synthetic-access");
  await assert.rejects(() => cipher.unseal(encrypted, env.TOKEN_ENCRYPTION_KEY, "bob"));
  await assert.rejects(() => cipher.unseal(encrypted, "b2".repeat(32), "alice"));
  await assert.rejects(() => cipher.seal("self-test", "invalid-key", "self-test"), error => error.kind === "encryption_key_unavailable");
  const invalidConfiguration = feishu.configuration({ ...env, TOKEN_ENCRYPTION_KEY: "invalid-key" });
  assert.equal(invalidConfiguration.configured, false, "An unusable encryption key must not report configuration ready");
  assert.ok(invalidConfiguration.missing.includes("TOKEN_ENCRYPTION_KEY_FORMAT"));
  const diagnostic = core.diagnosticMessage(new Error("Token synthetic-secret Bearer synthetic-token https://example.test/callback?code=synthetic-code&state=private"), ["synthetic-secret", "synthetic-code"]);
  assert.ok(!diagnostic.includes("synthetic-secret") && !diagnostic.includes("synthetic-token") && !diagnostic.includes("synthetic-code") && !diagnostic.includes("state="), "Diagnostics must redact credentials and callback parameters");

  const originalAlice = await clients.issueClientKey(env, "alice");
  const bobKey = await clients.issueClientKey(env, "bob");
  assert.equal(await clients.clientUser(env, originalAlice.headers.Authorization), "alice");
  const aliceKey = await clients.issueClientKey(env, "alice");
  await assert.rejects(() => clients.clientUser(env, originalAlice.headers.Authorization));
  assert.equal(await clients.clientUser(env, bobKey.headers.Authorization), "bob", "Rotation must preserve another user's credentials");
  assert.equal(aliceKey.url, env.SITE_ORIGIN + "/api/client-mcp");
  assert.equal(aliceKey.headers["OAI-Sites-Authorization"], "Bearer synthetic-site-access");
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM feishu_client_keys").all()).includes(aliceKey.headers.Authorization.slice(7)), "Only key hashes may be stored");
  assert.equal((await clientRpc("initialize", { protocolVersion: "2025-06-18" }, aliceKey.headers.Authorization)).result.serverInfo.title, "飞书");
  assert.deepEqual((await clientRpc("tools/list", {}, aliceKey.headers.Authorization)).result.tools.map(tool => tool.name), clients.CLIENT_TOOLS);
  assert.equal((await clientRpc("tools/call", { name: "feishu_connection_status" })).error, "authorization_required", "Caller-supplied identity alone must not authorize tools");
  assert.equal((await clientRpc("tools/call", { name: "feishu_write_document" }, aliceKey.headers.Authorization)).result.structuredContent.error, "unknown_tool");
  sqlite.prepare("UPDATE feishu_client_keys SET expires_at = 0 WHERE user_id = ?").run("bob");
  await assert.rejects(() => clients.clientUser(env, bobKey.headers.Authorization));
  for (const headers of [{ origin: env.SITE_ORIGIN }, { "oai-authenticated-user-id": "alice", origin: "https://attacker.example" }]) {
    assert.equal((await keyRoute.POST(new Request(env.SITE_ORIGIN + "/api/client-keys", { method: "POST", headers }))).status, 403);
  }

  const redirectAuth = new URL(await feishu.startAuthorization(env, "redirect-test"));
  let redirectRequests = 0;
  globalThis.fetch = async (url, request) => {
    redirectRequests++;
    assert.equal(request.redirect, "manual", "Edge-compatible redirect handling must prevent forwarding credentials");
    return new Response(null, { status: 307, headers: { Location: "https://untrusted.example/token" } });
  };
  await assert.rejects(() => feishu.finishAuthorization(env, "redirect-test", "synthetic-code", redirectAuth.searchParams.get("state"), false), error => error.kind === "provider_redirect");
  await assert.rejects(() => feishu.apiWithToken("synthetic-token", "/authen/v1/user_info"), error => error.kind === "provider_redirect");
  assert.equal(redirectRequests, 2, "Each provider redirect must stop after one request");
  globalThis.fetch = async () => Response.json({ code: 20003, error: "invalid_grant", error_description: "Invalid authorization code" }, { status: 400 });
  const healthResponse = await healthRoute.POST(new Request(env.SITE_ORIGIN + "/api/health", { method: "POST", headers: { Origin: env.SITE_ORIGIN } }));
  const healthReport = await healthResponse.json();
  assert.equal(healthResponse.status, 200, "A deliberate invalid-code response must verify callback transport rather than report a service failure");
  assert.equal(healthReport.checks.oauth_callback, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM feishu_connections").get().count, 0, "The negative-code diagnostic must never create a real account connection");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM feishu_oauth_states WHERE user_id LIKE 'self-test:%'").get().count, 0, "Diagnostics must remove temporary OAuth state");

  const auth = new URL(await feishu.startAuthorization(env, "alice"));
  assert.equal(auth.origin, "https://accounts.feishu.cn");
  assert.equal(auth.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(auth.searchParams.has("code_challenge"), false, "Feishu's v1 authorize PKCE must not be paired with the v3 token endpoint");
  assert.equal(auth.searchParams.has("code_challenge_method"), false);
  assert.equal(auth.searchParams.get("redirect_uri"), env.SITE_ORIGIN + "/auth/feishu/callback");
  assert.equal(auth.searchParams.get("scope"), core.SCOPES.join(" "));
  const state = auth.searchParams.get("state");
  await assert.rejects(() => feishu.finishAuthorization(env, "bob", "code", state, false), /已过期|已使用/);
  globalThis.fetch = async (url, request = {}) => {
    calls.push({ url: String(url), body: request.body?.toString() });
    if (String(url).includes("/token")) {
      const body = new URLSearchParams(request.body);
      assert.equal(body.get("scope"), core.SCOPES.join(" "));
      assert.equal(String(url), "https://accounts.feishu.cn/oauth/v3/token");
      assert.equal(body.get("client_id"), env.FEISHU_APP_ID);
      assert.equal(body.get("client_secret"), env.FEISHU_APP_SECRET, "Confidential clients must authenticate server-side with their secret");
      assert.equal(body.has("code_verifier"), false);
      assert.equal(body.get("redirect_uri"), auth.searchParams.get("redirect_uri"));
      return Response.json({ code: 0, access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, refresh_token_expires_in: 86400, scope: core.SCOPES.join(" ") });
    }
    return Response.json({ code: 0, data: { open_id: "ou_test", name: "测试账号" } });
  };
  await feishu.finishAuthorization(env, "alice", "code", state, false);
  assert.equal(calls.length, 2);
  await assert.rejects(() => feishu.finishAuthorization(env, "alice", "code", state, false));
  assert.equal(calls.length, 2, "Consumed state must prevent another provider call");
  const changedApp = new URL(await feishu.startAuthorization(env, "changed-app"));
  await assert.rejects(() => feishu.finishAuthorization({ ...env, FEISHU_APP_ID: "cli_different" }, "changed-app", "code", changedApp.searchParams.get("state"), false), error => error.kind === "invalid_state");
  const oldFlow = new URL(await feishu.startAuthorization(env, "old-flow"));
  sqlite.prepare("UPDATE feishu_oauth_states SET encrypted_verifier = ? WHERE user_id = ?").run(await cipher.seal("previous-pkce-verifier", env.TOKEN_ENCRYPTION_KEY, "old-flow"), "old-flow");
  await assert.rejects(() => feishu.finishAuthorization(env, "old-flow", "code", oldFlow.searchParams.get("state"), false), error => error.kind === "invalid_state");
  assert.equal(calls.length, 2, "Changed application settings and superseded OAuth flows must fail before contacting Feishu");
  const status = await feishu.status(env, "alice");
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes("synthetic-access"));
  assert.ok(!JSON.stringify(status).includes("synthetic-test-secret"));
  assert.equal((await feishu.status(env, "bob")).connected, false);
  await assert.rejects(() => feishu.accessToken(env, "bob"));
  assert.equal((await clientRpc("tools/call", { name: "feishu_connection_status" }, aliceKey.headers.Authorization, "bob")).result.structuredContent.account_name, "测试账号", "Verified key must determine identity, regardless of supplied header");
  for (const headers of [{ Origin: env.SITE_ORIGIN }, { Origin: "https://attacker.example", "oai-authenticated-user-id": "alice" }]) assert.equal((await readTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-read", { method: "POST", headers }))).status, 403);
  for (const document of ["https://attacker.example/docx/" + id, "../etc/passwd", ""]) assert.equal((await readTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-read", { method: "POST", headers: { Origin: env.SITE_ORIGIN, "oai-authenticated-user-id": "alice" }, body: JSON.stringify({ document }) }))).status, 400);
  let readRequests = 0;
  globalThis.fetch = async (url, request) => {
    readRequests++;
    assert.equal(String(url), `https://open.feishu.cn/open-apis/docx/v1/documents/${id}/raw_content`, "The browser test must read the document selected by this visitor");
    assert.equal(request.headers.Authorization, "Bearer synthetic-access");
    return Response.json({ code: 0, data: { content: "文档测试正文".repeat(300) } });
  };
  const readReply = await (await readTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-read", { method: "POST", headers: { Origin: env.SITE_ORIGIN, "oai-authenticated-user-id": "alice" }, body: JSON.stringify({ document: id }) }))).json();
  assert.equal(readReply.result.structuredContent.total_characters, 1800);
  const bobRead = await (await readTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-read", { method: "POST", headers: { Origin: env.SITE_ORIGIN, "oai-authenticated-user-id": "bob" }, body: JSON.stringify({ document: id }) }))).json();
  assert.equal(bobRead.result.structuredContent.error, "connection_required");
  assert.equal(readRequests, 1, "An unconnected visitor must not use another account's credentials");

  const chatId = "oc_synthetic_chat123", threadId = "omt_synthetic_thread123";
  let chatRequests = [];
  globalThis.fetch = async (input, request) => {
    const url = new URL(String(input));
    chatRequests.push({ url, method: request.method, body: request.body });
    assert.equal(request.headers.Authorization, "Bearer synthetic-access");
    if (url.pathname === "/open-apis/im/v1/chats") return Response.json({ code: 0, data: { items: [{ chat_id: chatId, name: "测试群", description: "测试描述" }], has_more: true, page_token: "next+page/=cursor" } });
    if (url.pathname.endsWith("/members/list")) return Response.json({ code: 0, data: { users: [{ member_id: "ou_member", name: "成员" }], bots: [], user_total: -1, has_more: false, truncations: [{ limit: 100, member_type: "user" }] } });
    if (url.pathname.endsWith("/messages/search")) {
      assert.deepEqual(JSON.parse(request.body), { query: "词库", filter: { chat_type: "group", chat_ids: [chatId], time_range: { start_time: "2026-10-12T00:00:00+08:00", end_time: "2026-10-13T00:00:00+08:00" } } });
      assert.equal(url.searchParams.get("page_size"), "30");
      return Response.json({ code: 0, data: { items: [{ id: "om_synthetic", display_info: "命中<h>词库</h>", meta_data: { chat_id: chatId, thread_id: threadId } }], has_more: true, page_token: "search-next" } });
    }
    assert.equal(url.pathname, "/open-apis/im/v1/messages");
    return Response.json({ code: 0, data: { items: [{ message_id: "om_synthetic", chat_id: chatId, thread_id: threadId, create_time: "1791800718585", msg_type: "post", sender: { id: "ou_sender", sender_name: "发送者" }, body: { content: JSON.stringify({ content: [[{ tag: "text", text: "第一行" }], [{ tag: "text", text: "第二行" }]] }) } }], has_more: false } });
  };
  const invokeChat = async (name, args = {}, key = aliceKey.headers.Authorization) => (await clientRpc("tools/call", { name, arguments: args }, key)).result;
  const listed = await invokeChat("feishu_list_chats", { limit: 5, page_token: "opaque+/=" });
  assert.equal(listed.structuredContent.chats[0].name, "测试群");
  assert.equal(listed.structuredContent.complete, false);
  assert.equal(chatRequests[0].url.searchParams.get("page_token"), "opaque+/=", "Opaque cursors must survive URL encoding");
  const history = await invokeChat("feishu_read_chat_messages", { chat_id: chatId, start_time: "2026-10-12T00:00:00+08:00" });
  assert.equal(history.structuredContent.messages[0].content, "第一行\n第二行");
  assert.equal(history.structuredContent.messages[0].sender.name, "发送者");
  assert.equal(history.structuredContent.messages[0].create_time, "2026-10-12T10:25:18.585Z");
  assert.equal(chatRequests[1].url.searchParams.get("start_time"), "1791734400");
  await invokeChat("feishu_read_thread_messages", { thread_id: threadId });
  assert.equal(chatRequests[2].url.searchParams.get("container_id_type"), "thread");
  assert.equal(chatRequests[2].url.searchParams.has("only_thread_root_messages"), false);
  const searched = await invokeChat("feishu_search_chat_messages", { query: "词库", chat_id: chatId, limit: 30, start_time: "2026-10-12T00:00:00+08:00", end_time: "2026-10-13T00:00:00+08:00" });
  assert.equal(searched.structuredContent.matches[0].snippet, "命中词库");
  assert.equal(searched.structuredContent.page_token, "search-next");
  const members = await invokeChat("feishu_list_chat_members", { chat_id: chatId });
  assert.equal(members.structuredContent.complete, false, "Server truncation must be retained even when has_more is false");
  assert.equal(members.structuredContent.user_total, null, "Unknown totals must not be shown as a negative member count");
  for (const [name, args] of [["feishu_read_chat_messages", { chat_id: "../../secrets" }], ["feishu_read_thread_messages", { thread_id: chatId }], ["feishu_search_chat_messages", { query: "词库", limit: 31 }], ["feishu_search_chat_messages", { query: "词库", start_time: "2026-10-13T00:00:00+08:00", end_time: "2026-10-12T00:00:00+08:00" }], ["feishu_list_chats", { limit: 101 }]]) assert.equal((await invokeChat(name, args)).structuredContent.error, "invalid_input");
  assert.equal(chatRequests.length, 5, "Invalid input must not trigger provider calls; each valid chat tool makes exactly one request");
  for (const headers of [{ Origin: env.SITE_ORIGIN }, { Origin: "https://attacker.example", "oai-authenticated-user-id": "alice" }]) assert.equal((await chatTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-chats", { method: "POST", headers }))).status, 403);
  const browserChat = await (await chatTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-chats", { method: "POST", headers: { Origin: env.SITE_ORIGIN, "oai-authenticated-user-id": "alice" }, body: JSON.stringify({ tool: "feishu_send_message" }) }))).json();
  assert.equal(browserChat.result.structuredContent.chats.length, 1, "The browser test must ignore caller-selected tools");
  const bobChats = await (await chatTestRoute.POST(new Request(env.SITE_ORIGIN + "/api/test-chats", { method: "POST", headers: { Origin: env.SITE_ORIGIN, "oai-authenticated-user-id": "bob" }, body: JSON.stringify({ document: id }) }))).json();
  assert.equal(bobChats.result.structuredContent.error, "connection_required");
  assert.equal(chatRequests.length, 6, "Another visitor must not read Alice's groups");

  sqlite.prepare("INSERT INTO feishu_connections (user_id, encrypted_tokens, expires_at, name, open_id, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("old-doc-user", await cipher.seal({ access_token: "old-doc-access", refresh_token: "old-doc-refresh" }, env.TOKEN_ENCRYPTION_KEY, "old-doc-user"), 0, "旧文档用户", "ou_old", core.DOCUMENT_SCOPES.join(" "), 0);
  const oldKey = await clients.issueClientKey(env, "old-doc-user");
  const needsAuth = await invokeChat("feishu_list_chats", {}, oldKey.headers.Authorization);
  assert.equal(needsAuth.structuredContent.error, "additional_authorization_required");
  assert.deepEqual(needsAuth.structuredContent.missing_scopes, ["im:chat:read"]);
  assert.equal(chatRequests.length, 6, "Unconsented chat reads must not call the provider or refresh an old grant");
  globalThis.fetch = async (url, request) => {
    assert.equal(String(url), "https://accounts.feishu.cn/oauth/v3/token");
    assert.equal(new URLSearchParams(request.body).get("scope"), core.DOCUMENT_SCOPES.join(" "), "Old document-only grants must refresh with their existing scope");
    return Response.json({ code: 0, access_token: "old-doc-renewed", refresh_token: "old-doc-rotated", expires_in: 3600, scope: core.DOCUMENT_SCOPES.join(" ") });
  };
  assert.equal(await feishu.accessToken(env, "old-doc-user"), "old-doc-renewed");
  assert.equal((await feishu.status(env, "old-doc-user")).connected, true);
  assert.equal((await feishu.status(env, "old-doc-user")).messaging_ready, false);
  globalThis.fetch = async () => Response.json({ code: 99991403 }, { status: 400 });
  const quota = await invokeChat("feishu_list_chats");
  assert.equal(quota.structuredContent.error, "api_quota_exhausted");
  assert.equal((await feishu.status(env, "alice")).connected, true, "Quota errors must not revoke user authorization");

  sqlite.prepare("UPDATE feishu_connections SET expires_at = 0 WHERE user_id = ?").run("alice");
  calls = [];
  globalThis.fetch = async (url, request) => {
    calls.push({ url: String(url) });
    assert.equal(new URLSearchParams(request.body).get("refresh_token"), "synthetic-refresh");
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ code: 0, access_token: "synthetic-renewed", refresh_token: "synthetic-rotated", expires_in: 3600, refresh_token_expires_in: 86400, scope: core.SCOPES.join(" ") });
  };
  const queryStart = databaseQueries.length;
  const keptAlive = [];
  const results = await runWithExecutionContext({ waitUntil: promise => keptAlive.push(promise) }, () => Promise.all(Array.from({ length: 100 }, () => feishu.accessToken(env, "alice"))));
  assert.equal(calls.length, 1, "Concurrent requests must not reuse a one-time refresh token");
  assert.deepEqual(results, Array(100).fill("synthetic-renewed"), "All 100 concurrent callers must receive the renewed token");
  const sharedQueries = databaseQueries.slice(queryStart);
  assert.equal(sharedQueries.filter(sql => sql.includes("RETURNING user_id")).length, 1, "One isolate must have only one refresh coordinator per account");
  assert.ok(sharedQueries.length <= 210, `Shared waiting must avoid per-caller polling: observed ${sharedQueries.length} queries`);
  assert.equal(keptAlive.length, 1, "The owning request must keep exactly one shared refresh alive after disconnection");
  await Promise.all(keptAlive);
  assert.equal(await feishu.accessToken(env, "alice"), "synthetic-renewed");

  const seedWaitingConnection = async (user, leaseExpires = Math.floor(Date.now() / 1000) + 30) => {
    sqlite.prepare("INSERT INTO feishu_connections (user_id, encrypted_tokens, expires_at, name, open_id, scope, refresh_lock, lock_expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(user, await cipher.seal({ access_token: "waiting-access", refresh_token: "waiting-refresh" }, env.TOKEN_ENCRYPTION_KEY, user), 0, "续期测试", "ou_wait", core.SCOPES.join(" "), "other-isolate", leaseExpires, 0);
  };
  const unlockFixture = user => sqlite.prepare("UPDATE feishu_connections SET refresh_lock = NULL, lock_expires_at = NULL WHERE user_id = ?").run(user);
  const withVirtualTime = async task => {
    const actualNow = Date.now, actualTimeout = globalThis.setTimeout;
    let time = actualNow();
    const started = time;
    try {
      Date.now = () => time;
      globalThis.setTimeout = (callback, duration) => {
        // Keep per-request watchdogs on real timers; advance only simulated I/O
        // and polling. All watchdogs are cleared when the refresh completes.
        if (duration >= 45000) return actualTimeout(callback, duration);
        time += duration; queueMicrotask(callback); return 0;
      };
      await task(() => time - started);
    } finally { Date.now = actualNow; globalThis.setTimeout = actualTimeout; }
  };

  const isolates = await Promise.all(Array.from({ length: 4 }, (_, index) => import(pathToFileURL(`${directory}/feishu.mjs`) + `?isolate=${index}`)));
  await seedWaitingConnection("cross-isolate");
  unlockFixture("cross-isolate");
  let crossIsolateRefreshes = 0;
  globalThis.fetch = async () => {
    crossIsolateRefreshes++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ code: 0, access_token: "cross-isolate-renewed", refresh_token: "cross-isolate-rotated", expires_in: 3600, scope: core.SCOPES.join(" ") });
  };
  const crossStart = databaseQueries.length;
  const crossResults = await Promise.all(isolates.flatMap(isolate => Array.from({ length: 25 }, () => isolate.accessToken(env, "cross-isolate"))));
  assert.deepEqual(crossResults, Array(100).fill("cross-isolate-renewed"));
  assert.equal(crossIsolateRefreshes, 1, "Separate isolate-local Promise pools must still share the database lease");
  assert.ok(databaseQueries.slice(crossStart).filter(sql => sql.includes("RETURNING user_id")).length <= 4, "Cross-isolate contention must scale with coordinators, not all 100 callers");

  await seedWaitingConnection("slow-refresh");
  unlockFixture("slow-refresh");
  let slowRefreshes = 0;
  await withVirtualTime(async elapsed => {
    globalThis.fetch = async () => {
      slowRefreshes++;
      await new Promise(resolve => setTimeout(resolve, 12000));
      return Response.json({ code: 0, access_token: "slow-renewed", refresh_token: "slow-rotated", expires_in: 3600, scope: core.SCOPES.join(" ") });
    };
    assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => feishu.accessToken(env, "slow-refresh"))), Array(100).fill("slow-renewed"));
    assert.equal(elapsed(), 12000, "Local waiters must not time out before the provider's existing 15s timeout");
  });
  assert.equal(slowRefreshes, 1);

  for (const user of ["parallel-a", "parallel-b"]) {
    await seedWaitingConnection(user);
    unlockFixture(user);
    sqlite.prepare("UPDATE feishu_connections SET encrypted_tokens = ? WHERE user_id = ?").run(await cipher.seal({ access_token: user + "-old", refresh_token: user + "-refresh" }, env.TOKEN_ENCRYPTION_KEY, user), user);
  }
  let releaseParallel, signalBothStarted;
  const parallelGate = new Promise(resolve => { releaseParallel = resolve; });
  const bothStarted = new Promise(resolve => { signalBothStarted = resolve; });
  let parallelStarted = 0;
  globalThis.fetch = async (url, request) => {
    const refresh = new URLSearchParams(request.body).get("refresh_token");
    if (++parallelStarted === 2) signalBothStarted();
    await parallelGate;
    return Response.json({ code: 0, access_token: refresh + "-access", refresh_token: refresh + "-rotated", expires_in: 3600, scope: core.SCOPES.join(" ") });
  };
  const parallelCalls = Promise.all([feishu.accessToken(env, "parallel-a"), feishu.accessToken(env, "parallel-b")]);
  let parallelTimeout;
  try { await Promise.race([bothStarted, new Promise((_, reject) => { parallelTimeout = setTimeout(() => reject(new Error("Different accounts must not share a global refresh queue")), 1000); })]); }
  finally { clearTimeout(parallelTimeout); releaseParallel(); }
  assert.deepEqual(await parallelCalls, ["parallel-a-refresh-access", "parallel-b-refresh-access"], "Refresh results must remain bound to their account");

  await seedWaitingConnection("reduced-scope");
  unlockFixture("reduced-scope");
  let scopeRefreshes = 0;
  globalThis.fetch = async () => {
    scopeRefreshes++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ code: 0, access_token: "document-only-renewed", refresh_token: "document-only-rotated", expires_in: 3600, scope: core.DOCUMENT_SCOPES.join(" ") });
  };
  const mixedScopes = await Promise.allSettled([feishu.accessToken(env, "reduced-scope", ["im:chat:read"]), feishu.accessToken(env, "reduced-scope", ["docx:document:readonly"])]);
  assert.equal(scopeRefreshes, 1);
  assert.equal(mixedScopes[0].status, "rejected");
  assert.equal(mixedScopes[0].reason.kind, "additional_authorization_required");
  assert.equal(mixedScopes[1].value, "document-only-renewed", "Sharing work must not share the first caller's scope decision");

  await seedWaitingConnection("provider-failure");
  unlockFixture("provider-failure");
  let failingRefreshes = 0;
  globalThis.fetch = async () => { failingRefreshes++; await new Promise(resolve => setTimeout(resolve, 30)); return Response.json({ error: "temporarily_unavailable" }, { status: 503 }); };
  const failedCalls = await Promise.allSettled(Array.from({ length: 100 }, () => feishu.accessToken(env, "provider-failure")));
  assert.equal(failingRefreshes, 1, "A failed refresh must be shared instead of starting 100 provider retries");
  assert.ok(failedCalls.every(result => result.status === "rejected" && result.reason.kind === "oauth_error"));
  assert.ok(sqlite.prepare("SELECT refresh_lock FROM feishu_connections WHERE user_id = ?").get("provider-failure").refresh_lock, "Provider failures must leave a short cross-isolate cooldown");
  await withVirtualTime(async elapsed => {
    globalThis.fetch = async () => { failingRefreshes++; return Response.json({ code: 0, access_token: "recovered-access", refresh_token: "recovered-refresh", expires_in: 3600, scope: core.SCOPES.join(" ") }); };
    assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => feishu.accessToken(env, "provider-failure"))), Array(100).fill("recovered-access"));
    assert.ok(elapsed() >= 2000 && elapsed() < 6000, "The failed flight must be removable and retry only after a brief cooldown");
  });
  assert.equal(failingRefreshes, 2);

  await seedWaitingConnection("disconnect-in-refresh");
  unlockFixture("disconnect-in-refresh");
  globalThis.fetch = async () => {
    await feishu.disconnect(env, "disconnect-in-refresh");
    return Response.json({ code: 0, access_token: "must-not-escape", refresh_token: "must-not-store", expires_in: 3600, scope: core.SCOPES.join(" ") });
  };
  const disconnectedCalls = await Promise.allSettled(Array.from({ length: 50 }, () => feishu.accessToken(env, "disconnect-in-refresh")));
  assert.ok(disconnectedCalls.every(result => result.status === "rejected" && result.reason.kind === "connection_required"), "An in-flight refresh must not return credentials after disconnection");
  assert.equal(sqlite.prepare("SELECT * FROM feishu_connections WHERE user_id = ?").get("disconnect-in-refresh"), undefined);

  await seedWaitingConnection("reconnect-in-refresh");
  unlockFixture("reconnect-in-refresh");
  const replacement = await cipher.seal({ access_token: "replacement-access", refresh_token: "replacement-refresh" }, env.TOKEN_ENCRYPTION_KEY, "reconnect-in-refresh");
  globalThis.fetch = async () => {
    sqlite.prepare("UPDATE feishu_connections SET encrypted_tokens = ?, expires_at = ?, scope = ?, refresh_lock = NULL, lock_expires_at = NULL WHERE user_id = ?").run(replacement, Math.floor(Date.now() / 1000) + 3600, core.DOCUMENT_SCOPES.join(" "), "reconnect-in-refresh");
    return Response.json({ code: 0, access_token: "obsolete-access", refresh_token: "obsolete-refresh", expires_in: 3600, scope: core.SCOPES.join(" ") });
  };
  await assert.rejects(() => feishu.accessToken(env, "reconnect-in-refresh"), error => error.kind === "connection_changed");
  assert.equal(await feishu.accessToken(env, "reconnect-in-refresh", ["docx:document:readonly"]), "replacement-access", "Old work must never overwrite a newly authorized connection");
  await assert.rejects(() => feishu.accessToken(env, "reconnect-in-refresh", ["im:chat:read"]), error => error.kind === "additional_authorization_required");

  await seedWaitingConnection("crashed-isolate");
  let takeoverRefreshes = 0;
  await withVirtualTime(async elapsed => {
    globalThis.fetch = async () => {
      takeoverRefreshes++;
      return Response.json({ code: 0, access_token: "takeover-access", refresh_token: "takeover-refresh", expires_in: 3600, scope: core.SCOPES.join(" ") });
    };
    assert.equal(await feishu.accessToken(env, "crashed-isolate"), "takeover-access");
    assert.ok(elapsed() >= 29000 && elapsed() < 35000, "Waiters must be able to recover a full abandoned 30s lease");
  });
  assert.equal(takeoverRefreshes, 1);

  await seedWaitingConnection("abandoned-flight");
  unlockFixture("abandoned-flight");
  let expireFlight, finishAbandoned, signalAbandonedStarted;
  const abandonedStarted = new Promise(resolve => { signalAbandonedStarted = resolve; });
  const abandonedResponse = new Promise(resolve => { finishAbandoned = resolve; });
  const originalTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (callback, duration) => {
      if (duration >= 45000) { expireFlight = callback; return 0; }
      return originalTimeout(callback, duration);
    };
    globalThis.fetch = async () => { signalAbandonedStarted(); return abandonedResponse; };
    const abandonedCall = feishu.accessToken(env, "abandoned-flight");
    await abandonedStarted;
    expireFlight();
    await assert.rejects(() => abandonedCall, error => error.kind === "refresh_in_progress");
  } finally { globalThis.setTimeout = originalTimeout; }
  sqlite.prepare("UPDATE feishu_connections SET lock_expires_at = 0 WHERE user_id = ?").run("abandoned-flight");
  globalThis.fetch = async () => Response.json({ code: 0, access_token: "after-abandonment", refresh_token: "after-abandonment-refresh", expires_in: 3600, scope: core.SCOPES.join(" ") });
  assert.equal(await feishu.accessToken(env, "abandoned-flight"), "after-abandonment", "An abandoned local flight must be removed so later requests can recover");
  finishAbandoned(Response.json({ code: 0, access_token: "obsolete-abandoned-token", refresh_token: "obsolete-abandoned-refresh", expires_in: 3600, scope: core.SCOPES.join(" ") }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await feishu.accessToken(env, "abandoned-flight"), "after-abandonment", "Late completion must not overwrite the successor's grant");

  globalThis.fetch = async () => { throw new Error("A waiting caller must not contact Feishu while another isolate holds the lease"); };
  await seedWaitingConnection("external-refresh");
  const externalTokens = await cipher.seal({ access_token: "externally-renewed", refresh_token: "externally-rotated" }, env.TOKEN_ENCRYPTION_KEY, "external-refresh");
  const externalUpdate = new Promise(resolve => setTimeout(() => {
    sqlite.prepare("UPDATE feishu_connections SET encrypted_tokens = ?, expires_at = ? WHERE user_id = ?").run(externalTokens, Math.floor(Date.now() / 1000) + 3600, "external-refresh");
    resolve();
  }, 30));
  assert.equal(await feishu.accessToken(env, "external-refresh", ["im:chat:read"]), "externally-renewed", "A waiter must reread a token renewed by a different isolate");
  await externalUpdate;
  assert.equal(sqlite.prepare("SELECT refresh_lock FROM feishu_connections WHERE user_id = ?").get("external-refresh").refresh_lock, "other-isolate", "A waiter must never clear another request's lease");

  await seedWaitingConnection("disconnect-wait");
  const disconnection = new Promise((resolve, reject) => setTimeout(() => feishu.disconnect(env, "disconnect-wait").then(resolve, reject), 30));
  await assert.rejects(() => feishu.accessToken(env, "disconnect-wait"), error => error.kind === "connection_required");
  await disconnection;

  await seedWaitingConnection("scope-wait");
  const scopeUpdate = new Promise(resolve => setTimeout(() => {
    sqlite.prepare("UPDATE feishu_connections SET expires_at = ?, scope = ? WHERE user_id = ?").run(Math.floor(Date.now() / 1000) + 3600, core.DOCUMENT_SCOPES.join(" "), "scope-wait");
    resolve();
  }, 30));
  await assert.rejects(() => feishu.accessToken(env, "scope-wait", ["im:chat:read"]), error => error.kind === "additional_authorization_required");
  await scopeUpdate;

  await seedWaitingConnection("expired-lease", Math.floor(Date.now() / 1000) - 1);
  let expiredLeaseRefreshes = 0;
  globalThis.fetch = async (url, request) => {
    expiredLeaseRefreshes++;
    assert.equal(new URLSearchParams(request.body).get("refresh_token"), "waiting-refresh");
    return Response.json({ code: 0, access_token: "lease-renewed", refresh_token: "lease-rotated", expires_in: 3600, scope: core.SCOPES.join(" ") });
  };
  assert.equal(await feishu.accessToken(env, "expired-lease"), "lease-renewed");
  assert.equal(expiredLeaseRefreshes, 1, "A crashed isolate's expired lease must not prevent recovery");
  assert.equal(sqlite.prepare("SELECT refresh_lock FROM feishu_connections WHERE user_id = ?").get("expired-lease").refresh_lock, null);

  await seedWaitingConnection("long-lease", Math.floor(Date.now() / 1000) + 120);
  const actualNow = Date.now, actualTimeout = globalThis.setTimeout;
  let simulatedTime = actualNow();
  const waitStarted = simulatedTime;
  let timeoutProviderCalls = 0;
  try {
    Date.now = () => simulatedTime;
    globalThis.setTimeout = (callback, duration) => { if (duration >= 45000) return actualTimeout(callback, duration); simulatedTime += duration; queueMicrotask(callback); return 0; };
    globalThis.fetch = async () => { timeoutProviderCalls++; throw new Error("Must not bypass a held refresh lease"); };
    await assert.rejects(() => feishu.accessToken(env, "long-lease"), error => error.kind === "refresh_in_progress");
    assert.equal(simulatedTime - waitStarted, 35000, "Refresh waiting must stop at its bounded deadline");
    assert.equal(timeoutProviderCalls, 0);
    assert.equal(sqlite.prepare("SELECT refresh_lock FROM feishu_connections WHERE user_id = ?").get("long-lease").refresh_lock, "other-isolate");
  } finally { Date.now = actualNow; globalThis.setTimeout = actualTimeout; }

  await feishu.disconnect(env, "alice");
  assert.equal((await feishu.status(env, "alice")).connected, false);
  await assert.rejects(() => clients.clientUser(env, aliceKey.headers.Authorization), /已撤销/);
  env.CLIENT_MCP_PUBLIC = "true";
  assert.equal((await healthRoute.GET(new Request(env.SITE_ORIGIN + "/api/health"))).status, 401, "Opening the Site must not expose private runtime diagnostics");
  assert.equal((await healthRoute.POST(new Request(env.SITE_ORIGIN + "/api/health", { method: "POST" }))).status, 403, "Public callers must not trigger provider diagnostic requests");
  assert.equal((await healthRoute.POST(new Request(env.SITE_ORIGIN + "/api/health", { method: "POST", headers: { "oai-authenticated-user-id": "alice", Origin: "https://attacker.example" } }))).status, 403);
  console.log("PASS: 100 callers sharing one refresh with bounded database work and request lifetime retention; 100 callers across 4 independent isolates; slow refresh; parallel account isolation; per-caller scopes; failed-flight cleanup/cooldown/recovery; disconnect/reconnect during refresh; full abandoned-lease recovery; abandoned local-flight watchdog/recovery/fencing; bounded waiting; OAuth/client/document/chat/CSRF regression contracts");
} finally { globalThis.fetch = actualFetch; delete globalThis.__feishuTestEnv; sqlite.close(); await rm(directory, { recursive: true, force: true }); }
