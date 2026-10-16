import assert from "node:assert/strict";

export async function botCases({ call, rpc, success, env, route }) {
  const actualFetch = globalThis.fetch, originalSecret = env.FEISHU_APP_SECRET;
  const chat = "oc_announcement_fixture", path = `/docx/v1/chats/${chat}/announcement`;
  const metadata = { announcement_type: "docx", revision_id: 12, create_time: 1792051200, update_time: 1792051200 };
  const response = data => Response.json({ code: 0, data });
  const denied = code => Response.json({ code }, { status: 403 });
  const block = text => ({ text: { elements: [{ text_run: { content: text } }] } });
  let sequence = 0, config, requests;
  function scenario(overrides = {}) {
    env.FEISHU_APP_SECRET = `synthetic-bot-secret-${++sequence}`;
    requests = [];
    config = { userMember: true, botMember: true, enabled: true, userDenial: 1772004, ...overrides };
  }
  globalThis.fetch = async (url, options = {}) => {
    const address = new URL(url), api = address.pathname.replace("/open-apis", "");
    assert.equal(address.origin, "https://open.feishu.cn");
    assert.equal(options.redirect, "manual");
    const request = { api, method: options.method, authorization: options.headers.Authorization, query: address.searchParams };
    requests.push(request);
    if (api === "/auth/v3/tenant_access_token/internal") {
      assert.equal(request.method, "POST"); assert.equal(request.authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET });
      if (config.tokenRedirect) return new Response(null, { status: 302, headers: { Location: "https://attacker.example/" } });
      if (config.tokenFailure) { config.tokenFailure--; return Response.json({ code: 99991663 }, { status: 403 }); }
      return Response.json({ code: 0, tenant_access_token: config.malformedToken ? "" : "synthetic-tenant", expire: 7200 });
    }
    assert.ok(["Bearer synthetic-alice", "Bearer synthetic-bob", "Bearer synthetic-tenant"].includes(request.authorization));
    assert.equal(request.method, "GET", "The bot channel may never send messages, add members or perform resource writes");
    if (api === "/im/v1/chats") {
      const isBot = request.authorization === "Bearer synthetic-tenant";
      if (isBot && config.botScopeDenied) return denied(99991672);
      if (!isBot && config.loopingCursor) return response({ items: [], has_more: true, page_token: "same-cursor" });
      if (!isBot && config.pagedMembership && !request.query.has("page_token")) return response({ items: [], has_more: true, page_token: "next + & group" });
      if (!isBot && config.pagedMembership) assert.equal(request.query.get("page_token"), "next + & group");
      return response({ items: (isBot ? config.botMember : config.userMember) ? [{ chat_id: chat }] : [], has_more: false });
    }
    if (api === "/bot/v3/info") {
      assert.equal(request.authorization, "Bearer synthetic-tenant");
      return Response.json({ code: 0, bot: { open_id: "ou_bot_fixture", app_name: "公告读取测试机器人", activate_status: config.enabled ? 2 : 3, ip_white_list: ["private-setting"] } });
    }
    assert.ok(api === path || api === path + "/blocks", api);
    if (request.authorization !== "Bearer synthetic-tenant" && config.userDenial) return denied(config.userDenial);
    if (request.authorization === "Bearer synthetic-tenant" && config.botExternalDenied) return denied(1772004);
    if (api === path) return response(metadata);
    assert.equal(request.query.get("revision_id"), "-1");
    return response({ items: [block(config.longContent ? "长".repeat(1500) : "机器人已读取到公告正文")], has_more: false });
  };
  const tokenRequests = () => requests.filter(item => item.api.includes("tenant_access_token"));
  const botResourceRequests = () => requests.filter(item => item.authorization === "Bearer synthetic-tenant" && item.api.startsWith(path));
  try {
    scenario();
    for (const identity of ["other", ["bot"], 2, null]) assert.equal((await call("feishu_read_chat_announcement", { chat_id: chat, identity })).error, "invalid_input");
    assert.equal((await call("feishu_bot_status", { chat_id: "../bad" })).error, "invalid_input");
    assert.equal((await rpc("feishu_bot_status", {}, "")).error, "authorization_required");
    assert.equal((await call("feishu_read_chat_announcement", { chat_id: chat, identity: "bot" }, "bob")).error, "additional_authorization_required");
    assert.equal(requests.length, 0, "Invalid input, missing identity and missing user grants must fail before tenant access");

    scenario({ userMember: false });
    assert.equal((await call("feishu_read_chat_announcement", { chat_id: chat, identity: "bot" })).error, "chat_membership_required");
    assert.equal(tokenRequests().length, 0, "A caller cannot borrow the bot's broader visibility");
    assert.equal((await call("feishu_bot_status", { chat_id: chat })).error, "chat_membership_required");
    assert.equal(tokenRequests().length, 0);

    scenario({ userDenial: 0 });
    const asUser = await success("feishu_read_chat_announcement", { chat_id: chat });
    assert.equal(asUser.identity_used, "user"); assert.equal(tokenRequests().length, 0);
    for (const mode of [{ identity: "user", code: 1772004 }, { identity: "auto", code: 1770032 }]) {
      scenario({ userDenial: mode.code });
      assert.equal((await call("feishu_read_chat_announcement", { chat_id: chat, identity: mode.identity })).provider_code, mode.code);
      assert.equal(tokenRequests().length, 0, "Only an external-group restriction enables the automatic bot fallback");
    }

    scenario({ pagedMembership: true });
    const fallback = await success("feishu_read_chat_announcement", { chat_id: chat });
    assert.equal(fallback.identity_used, "bot"); assert.equal(fallback.content, "机器人已读取到公告正文");
    assert.equal(tokenRequests().length, 1);
    assert.ok(requests.findIndex(item => item.api.includes("tenant_access_token")) > requests.findIndex(item => item.query.has("page_token")), "Membership must be established before minting a tenant credential");
    assert.ok(!JSON.stringify(fallback).includes("synthetic-tenant"));
    assert.ok(!JSON.stringify(fallback).includes(env.FEISHU_APP_SECRET));
    const checked = await success("feishu_bot_status", { chat_id: chat });
    assert.equal(checked.announcement_metadata_readable, true); assert.equal(checked.content_read_verified, false);
    assert.equal(checked.bot_in_chat, true); assert.equal(checked.bot.name, "公告读取测试机器人");
    assert.ok(!JSON.stringify(checked).includes("private-setting"), "Diagnostics must not disclose bot IP allowlists");
    assert.equal(tokenRequests().length, 1, "The app token may be cached but each caller's membership must be checked again");

    scenario({ longContent: true });
    const first = await success("feishu_read_chat_announcement", { chat_id: chat, identity: "bot", max_characters: 1000 });
    assert.equal(first.complete, false); assert.equal(first.next_arguments.identity, "bot");
    config.userMember = false;
    const resourcesBefore = botResourceRequests().length;
    assert.equal((await call("feishu_read_chat_announcement", first.next_arguments)).error, "chat_membership_required");
    assert.equal(botResourceRequests().length, resourcesBefore, "Removing the user blocks continuation even with a cached app token");
    config.userMember = true;
    const last = await success("feishu_read_chat_announcement", first.next_arguments);
    assert.equal(first.content + last.content, "长".repeat(1500)); assert.equal(last.complete, true);

    scenario({ botMember: false });
    const notJoined = await call("feishu_read_chat_announcement", { chat_id: chat });
    assert.equal(notJoined.provider_code, 1772004); assert.equal(notJoined.bot_fallback.error, "bot_not_in_chat");
    assert.equal(botResourceRequests().length, 0);
    const botMissing = await success("feishu_bot_status", { chat_id: chat });
    assert.equal(botMissing.bot_in_chat, false); assert.equal(botMissing.diagnostic.error, "bot_not_in_chat");

    scenario({ botScopeDenied: true });
    const missingScope = await call("feishu_read_chat_announcement", { chat_id: chat });
    assert.equal(missingScope.bot_fallback.provider_code, 99991672); assert.match(missingScope.message, /应用身份权限/);
    assert.equal(botResourceRequests().length, 0);
    scenario({ enabled: false });
    const inactive = await success("feishu_bot_status", { chat_id: chat });
    assert.equal(inactive.bot.enabled, false); assert.equal(inactive.diagnostic.error, "bot_not_enabled");
    assert.equal(botResourceRequests().length, 0);
    scenario({ botExternalDenied: true });
    const external = await success("feishu_bot_status", { chat_id: chat });
    assert.equal(external.diagnostic.provider_code, 1772004); assert.match(external.next_step, /对外共享/);
    assert.equal(external.announcement_metadata_readable, null);

    for (const setting of [{ tokenRedirect: true }, { malformedToken: true }, { loopingCursor: true }]) {
      scenario(setting);
      const failure = await call("feishu_read_chat_announcement", { chat_id: chat, identity: "bot" });
      assert.ok(["provider_redirect", "invalid_response"].includes(failure.error));
      assert.ok(!JSON.stringify(failure).includes(env.FEISHU_APP_SECRET));
      assert.equal(botResourceRequests().length, 0);
    }
    scenario();
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => success("feishu_bot_status", {})));
    assert.ok(concurrent.every(value => value.bot.enabled)); assert.equal(tokenRequests().length, 1, "Concurrent status requests share one credential request");
    scenario({ tokenFailure: 1 });
    assert.ok((await success("feishu_bot_status", {})).diagnostic);
    assert.equal((await success("feishu_bot_status", {})).bot.enabled, true);
    assert.equal(tokenRequests().length, 2, "A failed credential request must not poison future checks");

    const url = env.SITE_ORIGIN + "/api/bot-status";
    const browserHeaders = { "oai-authenticated-user-id": "alice", Origin: env.SITE_ORIGIN };
    const apiCallsBefore = requests.length;
    for (const headers of [{}, { ...browserHeaders, Origin: "https://attacker.example" }]) assert.equal((await route.POST(new Request(url, { method: "POST", headers, body: "{}" }))).status, 403);
    for (const body of ["[]", '{"send_message":true}', "x".repeat(5000)]) assert.equal((await route.POST(new Request(url, { method: "POST", headers: browserHeaders, body }))).status, 400);
    assert.equal(requests.length, apiCallsBefore);
    const good = await route.POST(new Request(url, { method: "POST", headers: browserHeaders, body: JSON.stringify({ chat_id: chat }) }));
    assert.equal(good.status, 200); assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal((await good.json()).result.structuredContent.bot_in_chat, true);
    console.log("PASS: bot announcement fallback, explicit identities, independent app permissions, current per-user membership and continuation checks, no bot writes, token confidentiality/cache/concurrency, actionable diagnostics and same-origin status API");
  } finally { globalThis.fetch = actualFetch; env.FEISHU_APP_SECRET = originalSecret; }
}
