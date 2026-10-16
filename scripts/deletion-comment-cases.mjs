import assert from "node:assert/strict";

export async function deletionCommentCases({ success, call, rpc, response, requests, setHandler, sqlite, load }) {
  const doc = "D".repeat(27), comment = "comment_synthetic", taskId = "task-delete-synthetic", listId = "list-delete-synthetic";
  let sequence = 0;
  const args = value => ({ ...value, request_id: `deletion-comment-case-${++sequence}` });
  const documentArgs = { document: doc, expected_title: "Only this document", expected_revision_id: 4 };
  const meta = { document_id: doc, title: documentArgs.expected_title, revision_id: 4 };
  const docPath = `/docx/v1/documents/${doc}`, deletePath = `/drive/v1/files/${doc}`;
  let mutations = 0;
  setHandler(req => {
    if (req.path === docPath) { assert.equal(req.method, "GET"); return response({ document: meta }); }
    assert.equal(req.path, deletePath); assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined);
    assert.equal(req.url.searchParams.get("type"), "docx"); assert.equal(req.url.searchParams.get("async"), "false");
    mutations++; return response({});
  });
  const request = args(documentArgs);
  const deleted = await success("feishu_delete_document", request);
  assert.equal(deleted.deleted, true); assert.equal(deleted.destination, "recycle_bin");
  assert.equal((await success("feishu_delete_document", request)).replayed, true); assert.equal(mutations, 1);
  assert.equal((await call("feishu_delete_document", { ...request, expected_title: "Different document" })).error, "request_conflict");
  for (const changed of [{ expected_title: "Old name" }, { expected_revision_id: 3 }]) {
    assert.equal((await call("feishu_delete_document", args({ ...documentArgs, ...changed }))).error, "revision_conflict");
  }
  assert.equal(mutations, 1, "Renamed or edited documents must not be deleted");
  const preInvalid = requests.length;
  for (const document of ["https://team.feishu.cn/wiki/WikiSynthetic", "https://evil.example/docx/DocumentSynthetic", "https://team.feishu.cn/drive/folder/FolderSynthetic", "https://team.feishu.cn/sheets/SheetSynthetic"]) {
    assert.equal((await call("feishu_delete_document", args({ ...documentArgs, document }))).error, "invalid_input");
  }
  assert.equal((await call("feishu_delete_document", args({ ...documentArgs, expected_revision_id: null }))).error, "invalid_input");
  assert.equal(requests.length, preInvalid);
  for (const invalid of [{ ...meta, document_id: "OtherDocument" }, { title: meta.title }, { ...meta, revision_id: "4" }]) {
    setHandler(req => { assert.equal(req.method, "GET"); return response({ document: invalid }); });
    assert.equal((await call("feishu_delete_document", args(documentArgs))).error, "resource_precheck_failed");
  }
  setHandler(req => req.method === "GET" ? response({ document: meta }) : response({ task_id: "pending-delete-task" }));
  const pending = await success("feishu_delete_document", args(documentArgs));
  assert.equal(pending.deleted, false); assert.equal(pending.state, "pending");
  let failedDeletes = 0;
  setHandler(req => { if (req.method === "GET") return response({ document: meta }); failedDeletes++; return Response.json({ code: 1061073 }, { status: 403 }); });
  const deniedArgs = args(documentArgs);
  const denied = await call("feishu_delete_document", deniedArgs);
  assert.equal(denied.error, "feishu_api_error"); assert.equal(denied.provider_code, 1061073);
  assert.equal((await call("feishu_delete_document", deniedArgs)).error, "feishu_api_error"); assert.equal(failedDeletes, 1);
  let uncertainDeletes = 0;
  setHandler(req => { if (req.method === "GET") return response({ document: meta }); uncertainDeletes++; throw new Error("network interrupted"); });
  const uncertainArgs = args(documentArgs);
  assert.equal((await call("feishu_delete_document", uncertainArgs)).error, "write_status_unknown");
  assert.equal((await call("feishu_delete_document", uncertainArgs)).error, "write_status_unknown"); assert.equal(uncertainDeletes, 1);

  const task = { guid: taskId, summary: "Only this task", description: "test", updated_at: "12", members: [] };
  const taskHash = await (await load("productivity-tools")).taskHash(task);
  let taskDeletes = 0;
  setHandler(req => { assert.equal(req.path, `/task/v2/tasks/${taskId}`); if (req.method === "GET") return response({ task }); assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined); assert.equal(req.url.search, ""); taskDeletes++; return Response.json({ code: 0 }); });
  const taskRequest = args({ task_guid: taskId, expected_task_hash: taskHash });
  assert.equal((await success("feishu_delete_task", taskRequest)).deleted, true);
  assert.equal((await success("feishu_delete_task", taskRequest)).replayed, true);
  assert.equal((await call("feishu_delete_task", args({ task_guid: taskId, expected_task_hash: "outdated" }))).error, "revision_conflict");
  assert.equal(taskDeletes, 1);
  const list = { guid: listId, name: "Only this list" }; let listDeletes = 0;
  setHandler(req => { assert.equal(req.path, `/task/v2/tasklists/${listId}`); if (req.method === "GET") return response({ tasklist: list }); assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined); assert.equal(req.url.search, ""); listDeletes++; return Response.json({ code: 0 }); });
  const listRequest = args({ tasklist_guid: listId, expected_name: list.name });
  const listResult = await success("feishu_delete_tasklist", listRequest);
  assert.equal(listResult.deleted, true); assert.equal(listResult.individual_task_deletes_performed, false);
  assert.equal((await success("feishu_delete_tasklist", listRequest)).replayed, true);
  assert.equal((await call("feishu_delete_tasklist", args({ tasklist_guid: listId, expected_name: "Old list name" }))).error, "revision_conflict");
  assert.equal(listDeletes, 1, "Deleting a list must not issue deletes against its tasks");
  setHandler(req => { assert.equal(req.method, "GET"); return response({ tasklist: { guid: "other-list", name: list.name } }); });
  assert.equal((await call("feishu_delete_tasklist", args({ tasklist_guid: listId, expected_name: list.name }))).error, "resource_precheck_failed");

  const beforeScope = requests.length;
  for (const [name, parameters] of [["feishu_delete_document", documentArgs], ["feishu_delete_task", { task_guid: taskId, expected_task_hash: taskHash }], ["feishu_delete_tasklist", { tasklist_guid: listId, expected_name: list.name }]]) {
    assert.equal((await call(name, args(parameters), "bob")).error, "additional_authorization_required");
    assert.ok((await rpc(name, args(parameters), "")).error, "Anonymous deletes must be rejected at the MCP boundary");
  }
  assert.equal(requests.length, beforeScope, "Missing authorization must prevent all provider requests");

  const commentPath = `/drive/v1/files/${doc}/comments`, replyArgs = { document: doc, comment_id: comment, content: "确认 <value> > 0" };
  let replyWrites = 0;
  const commentHandler = state => setHandler(req => {
    assert.equal(req.method, "POST");
    if (req.path === `${commentPath}/batch_query`) {
      assert.deepEqual(req.body, { comment_ids: [comment] }); assert.equal(req.url.searchParams.get("file_type"), "docx");
      return response({ items: state });
    }
    assert.equal(req.path, `${commentPath}/${comment}/replies`);
    assert.equal(req.body.content.elements[0].text_run.text, "确认 &lt;value&gt; &gt; 0");
    replyWrites++; return response({ reply_id: "reply-synthetic" });
  });
  for (const [state, expected] of [
    [[{ comment_id: comment, is_whole: true, is_solved: false }], "comment_reply_not_supported"],
    [[{ comment_id: comment, is_whole: false, is_solved: true }], "comment_already_solved"],
    [[{ comment_id: comment }], "resource_precheck_failed"],
    [[], "comment_not_found"],
    [[{ comment_id: "wrong-comment", is_whole: false, is_solved: false }], "comment_not_found"],
  ]) {
    commentHandler(state); const request = args(replyArgs), first = await call("feishu_reply_document_comment", request);
    assert.equal(first.error, expected, JSON.stringify(first)); const reads = requests.length;
    assert.equal((await call("feishu_reply_document_comment", request)).error, expected); assert.equal(requests.length, reads);
  }
  assert.equal(replyWrites, 0, "Whole, solved, missing or uncertain comments must not cause a reply, new comment or restore");
  commentHandler([{ comment_id: comment, is_whole: false, is_solved: false }]);
  const replyRequest = args(replyArgs); assert.equal((await success("feishu_reply_document_comment", replyRequest)).reply_id, "reply-synthetic");
  assert.equal((await success("feishu_reply_document_comment", replyRequest)).replayed, true); assert.equal(replyWrites, 1);
  const scopes = sqlite.prepare("SELECT scope FROM feishu_connections WHERE user_id='alice'").get().scope;
  try {
    sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(scopes.split(" ").filter(s => !["docs:document.comment:read", "drive:drive:readonly"].includes(s)).join(" "));
    const before = requests.length;
    assert.equal((await call("feishu_reply_document_comment", args(replyArgs))).error, "additional_authorization_required"); assert.equal(requests.length, before);
  } finally { sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(scopes); }
  setHandler(() => response({ items: [{ comment_id: comment, is_whole: true, is_solved: false }, { is_whole: false, is_solved: true }, { is_whole: false, is_solved: false }, {}], has_more: false }));
  const items = (await success("feishu_list_document_comments", { document: doc })).items;
  assert.deepEqual(items.map(x => x.can_reply), [false, false, true, null]);
  setHandler(req => { assert.equal(req.path, `/drive/v1/files/${doc}/new_comments`); assert.ok(req.body.reply_elements[0].text.startsWith("&lt;x&gt;")); return response({ comment_id: comment }); });
  await success("feishu_add_document_comment", args({ document: doc, content: "<x>" + " ".repeat(1200) }));
  console.log("PASS: three scoped deletes, target/revision guards, no cascading task deletes, encrypted replay and uncertain-delete protection; whole/solved comment preflight, metadata failure, read permission and literal comment text");
}
