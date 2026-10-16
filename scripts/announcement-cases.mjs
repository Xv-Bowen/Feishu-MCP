import assert from "node:assert/strict";

export async function announcementCases({ success, call, response, requests, setHandler }) {
  const name = "feishu_read_chat_announcement", chat = "oc_announcement_fixture";
  const path = `/docx/v1/chats/${chat}/announcement`;
  const metadata = { announcement_type: "docx", revision_id: 12, create_time: 1792051200, update_time: 1792051200 };
  const block = text => ({ block_id: "block_fixture", text: { elements: [{ text_run: { content: text } }] } });
  const before = requests.length;
  const missing = await call(name, { chat_id: chat }, "bob");
  assert.equal(missing.error, "additional_authorization_required");
  assert.deepEqual(missing.missing_scopes, ["im:chat.announcement:read"]);
  assert.equal(requests.length, before, "Missing scope must fail before provider access");
  for (const args of [{ chat_id: "../../other" }, { chat_id: chat, limit: 101 }, { chat_id: chat, format: "html" }, { chat_id: chat, offset: 1 }, { chat_id: chat, page_token: "cursor" }, { chat_id: chat, expected_revision: 12 }]) {
    assert.equal((await call(name, args)).error, "invalid_input");
  }
  assert.equal(requests.length, before);

  setHandler(req => {
    assert.equal(req.method, "GET"); assert.equal(req.body, undefined);
    assert.equal(req.url.searchParams.get("user_id_type"), "open_id");
    if (req.path === path) return response(metadata);
    assert.equal(req.path, path + "/blocks");
    assert.equal(req.url.searchParams.get("revision_id"), "-1");
    assert.equal(req.url.searchParams.has("document_revision_id"), false);
    assert.equal(req.url.searchParams.get("page_size"), "50");
    if (req.url.searchParams.has("page_token")) {
      assert.equal(req.url.searchParams.get("page_token"), "next + & cursor");
      return response({ items: [block("最后一页")], has_more: false });
    }
    return response({ items: [{ block_id: "title_fixture", heading1: { elements: [{ text_run: { content: "群公告" } }] } }, { block_id: "link_fixture", text: { elements: [{ text_run: { content: "报名入口", text_element_style: { link: { url: "https%3A%2F%2Fexample.com%2Fjoin%3Fa%3D1%26b%3D2" } } } }] } }, { block_id: "image_fixture", image: { token: "imageReference" } }], has_more: true, page_token: "next + & cursor" });
  });
  const first = await success(name, { chat_id: chat });
  assert.match(first.content, /群公告/); assert.match(first.content, /https:\/\/example.com\/join\?a=1&b=2/);
  assert.match(first.content, /imageReference/); assert.equal(first.complete, false);
  assert.equal(first.revision, "12"); assert.match(first.update_time_beijing, /\+08:00$/);
  assert.equal(Date.parse(first.update_time), Date.parse(first.update_time_beijing));
  const last = await success(name, first.next_arguments);
  assert.equal(last.content, "最后一页"); assert.equal(last.complete, true); assert.equal(last.next_arguments, null);
  const raw = await success(name, { chat_id: chat, format: "json" });
  assert.equal(JSON.parse(raw.content)[2].image.token, "imageReference");

  setHandler(req => req.path === path ? response(metadata) : response({ items: [block("长".repeat(2501))], has_more: true, page_token: "another-page" }));
  const chunks = [];
  let args = { chat_id: chat, max_characters: 1000 };
  for (let i = 0; i < 3; i++) {
    const result = await success(name, args); chunks.push(result.content);
    assert.equal(result.complete, false);
    if (i < 2) { assert.equal(result.page_token, null); assert.equal(result.next_arguments.page_token, undefined); }
    else { assert.equal(result.next_arguments.page_token, "another-page"); assert.equal(result.next_arguments.offset, undefined); }
    args = result.next_arguments;
  }
  assert.equal(chunks.join(""), "长".repeat(2501), "Character chunks must not skip text before the next provider page");
  assert.equal((await call(name, { chat_id: chat, expected_revision: "11" })).error, "announcement_changed");
  let reads = 0;
  setHandler(req => req.path === path ? response({ ...metadata, revision_id: ++reads === 1 ? 12 : 13 }) : response({ items: [block("changed")], has_more: false }));
  assert.equal((await call(name, { chat_id: chat })).error, "announcement_changed");

  const legacy = JSON.stringify({ body: { blocks: [{ type: "paragraph", paragraph: { elements: [{ textRun: { text: "旧版公告", style: { link: { url: "https://example.com/legacy" } } } }] } }] } });
  setHandler(req => {
    if (req.path === path) return response({ ...metadata, announcement_type: "doc" });
    assert.equal(req.path, `/im/v1/chats/${chat}/announcement`); assert.equal(req.method, "GET");
    return response({ content: legacy, revision: "9007199254740993", update_time: "1792051200" });
  });
  const old = await success(name, { chat_id: chat });
  assert.equal(old.content, "旧版公告 (https://example.com/legacy)"); assert.equal(old.revision, "9007199254740993");
  assert.equal(old.complete, true); assert.equal(old.announcement_type, "doc");
  assert.equal((await success(name, { chat_id: chat, format: "json" })).content, legacy);
  assert.equal((await call(name, { chat_id: chat, expected_revision: "12" })).error, "announcement_changed");
  setHandler(req => req.path === path ? response({ ...metadata, announcement_type: "doc" }) : response({ revision: "12" }));
  assert.equal((await call(name, { chat_id: chat })).error, "invalid_response");

  setHandler(req => req.path === path ? response(metadata) : response({ items: [], has_more: false }));
  const empty = await success(name, { chat_id: chat }); assert.equal(empty.content, ""); assert.equal(empty.complete, true);
  for (const data of [{ items: [], has_more: true }, { items: "invalid", has_more: false }, {}]) {
    setHandler(req => req.path === path ? response(metadata) : response(data));
    assert.equal((await call(name, { chat_id: chat })).error, "invalid_response");
  }
  setHandler(() => new Response(JSON.stringify({ code: 1770032 }), { status: 403 }));
  const denied = await call(name, { chat_id: chat }); assert.equal(denied.provider_code, 1770032); assert.equal(denied.content, undefined);
  assert.ok(requests.slice(before).every(req => req.method === "GET"), "Reading announcements must never write");
  console.log("PASS: announcements: scoped read access, new/old formats, links, raw blocks, lossless continuation, version changes, empty vs denied and malformed responses");
}
