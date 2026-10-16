import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

// Exercise real request contexts and D1 bindings, without calling Feishu.
const wranglerRequire = createRequire(await realpath("node_modules/wrangler/package.json"));
const { Miniflare, createFetchMock, Log, LogLevel } = await import(wranglerRequire.resolve("miniflare"));
const { build } = await import(wranglerRequire.resolve("esbuild"));
const directory = path.resolve(".sites-runtime/refresh-worker-tests");
await mkdir(directory, { recursive: true });
let worker;
const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
let providerCalls = 0;
let writeCalls = 0;
fetchMock.get("https://accounts.feishu.cn").intercept({ path: "/oauth/v3/token", method: "POST" }).reply(200, () => {
  providerCalls++;
  return JSON.stringify({ code: 0, access_token: "worker-renewed", refresh_token: "worker-rotated", expires_in: 3600 });
}, { headers: { "Content-Type": "application/json" } }).delay(100).persist();
fetchMock.get("https://open.feishu.cn").intercept({ path: "/open-apis/docx/v1/documents", method: "POST" }).reply(200, () => {
  writeCalls++;
  return JSON.stringify({ code: 0, data: { document: { document_id: "SyntheticDocument" } } });
}, { headers: { "Content-Type": "application/json" } }).delay(100).persist();

try {
  await build({
    stdin: { contents: `
      import { accessToken, apiWithToken } from "./lib/feishu.ts";
      import { writeOnce } from "./lib/workspace-common.ts";
      import { seal } from "./lib/crypto.ts";
      import { SCOPES } from "./lib/core.ts";
      import { runWithExecutionContext } from "vinext/shims/request-context";
      let retained = 0;
      export default { async fetch(request, env, ctx) {
        return runWithExecutionContext({ waitUntil(promise) { retained++; ctx.waitUntil(promise); } }, async () => {
          const url = new URL(request.url);
          if (url.pathname === "/seed") {
            const encrypted = await seal({ access_token: "worker-expired", refresh_token: "worker-refresh" }, env.TOKEN_ENCRYPTION_KEY, "worker-user");
            await env.DB.prepare("INSERT INTO feishu_connections (user_id, encrypted_tokens, expires_at, name, open_id, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("worker-user", encrypted, 0, "Synthetic account", "ou_worker", [...SCOPES, "docx:document"].join(" "), 0).run();
            return new Response("ready");
          }
          if (url.pathname === "/metrics") return Response.json({ retained });
          if (url.pathname === "/write") {
            try {
              return Response.json(await writeOnce(env, "worker-user", "feishu_create_document", { title: "Synthetic", request_id: "worker-write-001" }, ["docx:document"], token => apiWithToken(token, "/docx/v1/documents", { title: "Synthetic" })));
            } catch (error) { return Response.json({ error: error.kind }, { status: error.status || 503 }); }
          }
          return Response.json({ token: await accessToken(env, "worker-user") });
        });
      } };`, resolveDir: process.cwd(), loader: "ts" },
    outfile: path.join(directory, "worker.mjs"), bundle: true, format: "esm", platform: "node", target: "es2022", external: ["node:async_hooks"], logLevel: "silent",
  });
  worker = new Miniflare({
    modules: true, scriptPath: path.join(directory, "worker.mjs"), compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"], d1Persist: false, fetchMock, log: new Log(LogLevel.ERROR),
    bindings: { FEISHU_APP_ID: "cli_worker_test", FEISHU_APP_SECRET: "synthetic-worker-secret", TOKEN_ENCRYPTION_KEY: "a1".repeat(32), SITE_ORIGIN: "https://worker-test.example" },
  });
  const database = await worker.getD1Database("DB");
  const schema = (await readFile("drizzle/0000_ordinary_lila_cheney.sql", "utf8")).split("--> statement-breakpoint")[0];
  await database.prepare(schema).run();
  await database.prepare(await readFile("drizzle/0003_legal_bushwacker.sql", "utf8")).run();
  assert.equal((await worker.dispatchFetch("https://worker-test.example/seed")).status, 200);
  const responses = await Promise.all(Array.from({ length: 100 }, () => worker.dispatchFetch("https://worker-test.example/refresh")));
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(await Promise.all(responses.map(response => response.json())), Array.from({ length: 100 }, () => ({ token: "worker-renewed" })));
  assert.equal(providerCalls, 1, "100 real Worker requests must rotate the refresh token once");
  const metrics = await (await worker.dispatchFetch("https://worker-test.example/metrics")).json();
  assert.equal(metrics.retained, 1, "Real D1 bindings must share exactly one instance-local refresh coordinator");
  const writes = await Promise.all(Array.from({ length: 100 }, () => worker.dispatchFetch("https://worker-test.example/write")));
  assert.ok(writes.every(response => [200, 409].includes(response.status)));
  const results = await Promise.all(writes.map(response => response.json()));
  assert.ok(results.some(result => result.document?.document_id === "SyntheticDocument"));
  assert.ok(results.every(result => result.document?.document_id === "SyntheticDocument" || result.error === "write_status_unknown"));
  assert.equal(writeCalls, 1, "100 real D1 write claims must produce one provider operation");
  const replay = await (await worker.dispatchFetch("https://worker-test.example/write")).json();
  assert.equal(replay.replayed, true); assert.equal(writeCalls, 1);
  const receipt = await database.prepare("SELECT status,encrypted_result FROM feishu_write_operations").first();
  assert.equal(receipt.status, "succeeded"); assert.ok(!receipt.encrypted_result.includes("SyntheticDocument"));
  console.log("PASS: real Worker/D1: 100 concurrent refresh requests, one mocked Feishu refresh, one retained coordinator; 100 duplicate write claims, one provider write and encrypted replay; no cross-request I/O errors");
} finally {
  await worker?.dispose();
  await fetchMock.close();
  await rm(directory, { recursive: true, force: true });
}
