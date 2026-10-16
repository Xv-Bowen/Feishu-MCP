import assert from "node:assert/strict";

export async function commentVerificationCases({ success, response, requests, setHandler }) {
  const document = "V".repeat(27), comment = "7696891164972027130", reply = "7696891164972027131";
  const base = `/drive/v1/files/${document}/comments`;
  const metadata = { comment_id: comment, user_id: "ou_alice", is_whole: true, is_solved: false, update_time: 100 };
  const replyItem = { reply_id: reply, user_id: "ou_alice", content: { elements: [{ type: "text_run", text_run: { text: "Disposable comment" } }] }, update_time: 100 };
  const providerError = code => Response.json({ code, msg: "Comment diagnostic; Bearer synthetic-upstream-secret" }, { status: 400 });
  let sequence = 0;
  async function scenario({ errorCode = 1069301, failReplies = false, list, deleteError = false, single = false }) {
    let deleted = false, deleteCalls = 0, listCalls = 0;
    setHandler(req => {
      if (req.path === `${base}/batch_query`) {
        assert.equal(req.method, "POST"); assert.deepEqual(req.body, { comment_ids: [comment] });
        return deleted && !failReplies ? providerError(errorCode) : response({ items: [metadata] });
      }
      if (req.path === `${base}/${comment}/replies` && req.method === "GET") {
        return deleted ? providerError(errorCode) : response({ items: [replyItem], has_more: false });
      }
      if (req.path === `${base}/${comment}/replies/${reply}` && req.method === "DELETE") {
        deleteCalls++;
        if (deleteError) return providerError(1069301);
        deleted = true; return response({});
      }
      assert.equal(req.path, base); assert.equal(req.method, "GET"); assert.equal(deleted, true);
      assert.equal(req.url.searchParams.get("file_type"), "docx");
      assert.equal(req.url.searchParams.get("user_id_type"), "open_id");
      assert.equal(req.url.searchParams.get("page_size"), "100");
      for (const field of ["is_whole", "is_solved"]) assert.ok(["true", "false"].includes(req.url.searchParams.get(field)), `${field} must be explicit`);
      listCalls++; return list(req, listCalls);
    });
    const inspected = await success("feishu_get_document_comment", { document, comment_id: comment });
    const name = single ? "feishu_delete_comment_reply" : "feishu_delete_document_comment";
    const args = { document, comment_id: comment, ...(single ? { reply_id: reply, expected_reply_hash: inspected.replies[0].reply_hash } : { expected_comment_hash: inspected.comment_hash }), request_id: `comment-verification-${++sequence}` };
    const result = await success(name, args);
    assert.equal(deleteCalls, 1);
    const beforeReplay = requests.length;
    assert.equal((await success(name, args)).replayed, true);
    assert.equal(requests.length, beforeReplay, "Receipt replay must not delete or verify again");
    assert.ok(!JSON.stringify(result).includes("synthetic-upstream-secret"));
    return { result, listCalls };
  }

  // The reported regression: the final reply was deleted successfully, but the
  // subsequent batch query fails. A complete list scan must prove absence.
  const seenFilters = [];
  let test = await scenario({ list: req => {
    seenFilters.push([req.url.searchParams.get("is_whole"), req.url.searchParams.get("is_solved")].join("/"));
    return response({ items: [], has_more: false });
  } });
  assert.equal(test.result.state, "deleted"); assert.equal(test.result.deleted, true);
  assert.equal(test.result.verified, true); assert.equal(test.result.verification_method, "comment_list");
  assert.deepEqual(test.result.deleted_reply_ids, [reply]); assert.deepEqual(test.result.remaining_reply_ids, []);
  assert.deepEqual(seenFilters.sort(), ["false/false", "false/true", "true/false", "true/true"]);

  for (const settings of [{ errorCode: 1069307 }, { failReplies: true }]) {
    test = await scenario({ ...settings, list: () => response({ items: [], has_more: false }) });
    assert.equal(test.result.deleted, true); assert.equal(test.listCalls, 4);
  }

  // An empty first page and absence from unresolved comments are insufficient.
  // The target remains on the second page of resolved whole comments.
  test = await scenario({ list: req => {
    if (req.url.searchParams.get("is_whole") !== "true" || req.url.searchParams.get("is_solved") !== "true") return response({ items: [], has_more: false });
    if (!req.url.searchParams.has("page_token")) return response({ items: [], has_more: true, page_token: "next +&page" });
    assert.equal(req.url.searchParams.get("page_token"), "next +&page");
    return response({ items: [{ ...metadata, is_solved: true }], has_more: false });
  } });
  assert.equal(test.result.deleted, false); assert.equal(test.result.state, "partial");
  assert.equal(test.result.comment_present, true); assert.equal(test.result.remaining_reply_ids, null);

  // Fully traversed non-empty lists also prove absence, without integer
  // conversion of 64-bit comment IDs or leaking unrelated comments.
  test = await scenario({ list: req => !req.url.searchParams.has("page_token")
    ? response({ items: [{ comment_id: "7696891164972027139" }], has_more: true, page_token: "next" })
    : response({ items: [{ comment_id: "7696891164972027140" }], has_more: false }) });
  assert.equal(test.result.deleted, true); assert.equal(test.listCalls, 8);
  assert.ok(!JSON.stringify(test.result).includes("7696891164972027139"));

  // No provider error, failed page, malformed response or incomplete scan may
  // be interpreted as disappearance; these must remain verification_required.
  for (const list of [
    () => providerError(1069301),
    () => providerError(1069303),
    () => { throw new Error("synthetic network failure"); },
    () => response({ items: [] }),
    () => response({ items: null, has_more: false }),
    () => response({ items: [{ comment_id: Number(comment) }], has_more: false }),
    () => response({ items: [], has_more: true }),
    () => response({ items: [], has_more: true, page_token: "repeated" }),
    req => response({ items: [{ comment_id: "7696891164972027139" }], has_more: !req.url.searchParams.has("page_token"), page_token: "next" }),
    (req, count) => response({ items: [], has_more: true, page_token: `page-${count}` }),
    req => req.url.searchParams.has("page_token") ? providerError(1069301) : response({ items: [], has_more: true, page_token: "next" }),
    req => req.url.searchParams.get("is_solved") === "true" ? providerError(1069301) : response({ items: [], has_more: false }),
  ]) {
    test = await scenario({ list });
    assert.equal(test.result.deleted, false); assert.equal(test.result.state, "verification_required");
    assert.equal(test.result.remaining_reply_ids, null); assert.ok(test.result.list_verification_error);
    assert.ok(test.listCalls <= 20, "Fallback must have a bounded total page budget");
  }

  test = await scenario({ deleteError: true, list: () => assert.fail("Do not verify a rejected delete as successful") });
  assert.equal(test.result.deleted, false); assert.equal(test.result.state, "failed"); assert.equal(test.listCalls, 0);
  test = await scenario({ single: true, list: () => assert.fail("Single-reply receipt only covers the requested reply") });
  assert.equal(test.result.deleted, true); assert.equal(test.result.scope, "single_reply");
  assert.equal(test.result.last_reply_in_snapshot, true); assert.match(test.result.note, /整条评论/);
  console.log("PASS: last-reply deletion verification, 1069301/1069307 fallback, all comment states, complete pagination, retained targets, failed/incomplete scans and replay without extra deletes");
}
