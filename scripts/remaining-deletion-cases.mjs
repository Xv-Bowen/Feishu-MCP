import assert from "node:assert/strict";

export async function remainingDeletionCases({ success, call, rpc, response, requests, setHandler, load }) {
  let sequence = 0;
  const write = args => ({ ...args, request_id: `remaining-delete-${++sequence}` });
  const writes = ["feishu_delete_folder", "feishu_delete_wiki_node", "feishu_delete_comment_reply", "feishu_delete_document_comment", "feishu_delete_document_blocks"];
  const registry = (await load("workspace-tools")).WORKSPACE_TOOLS;
  for (const name of writes) {
    const t = registry.find(item => item.name === name);
    assert.equal(t.annotations.readOnlyHint, false); assert.equal(t.annotations.destructiveHint, true);
    assert.ok(t.inputSchema.required.includes("request_id"));
  }

  const folder = "FolderRemainingTest", root = "RootRemainingTest", nested = "NestedRemainingTest";
  let entries = [], folderDeletes = 0, meta = { doc_token: folder, doc_type: "folder", title: "Disposable folder", latest_modify_time: "100" };
  let folderTask = "folder_task_123", rootId = root, malformedPages = false;
  const folderHandler = req => {
    if (req.path === "/drive/explorer/v2/root_folder/meta") return response({ token: rootId });
    if (req.path === "/drive/v1/metas/batch_query") {
      assert.deepEqual(req.body.request_docs, [{ doc_token: folder, doc_type: "folder" }]);
      return response({ metas: [meta] });
    }
    if (req.path === "/drive/v1/files") {
      const parent = req.url.searchParams.get("folder_token");
      if (malformedPages) return response({ files: [], has_more: true, next_page_token: "same" });
      if (parent === nested) return response({ files: [{ token: "NestedFileRemaining", name: "inside.csv", type: "file", parent_token: nested }], has_more: false });
      assert.equal(parent, folder);
      if (!req.url.searchParams.has("page_token")) return response({ files: [], has_more: true, next_page_token: "next +&page" });
      assert.equal(req.url.searchParams.get("page_token"), "next +&page");
      return response({ files: entries, has_more: false });
    }
    assert.equal(req.method, "DELETE"); assert.equal(req.path, `/drive/v1/files/${folder}`);
    assert.equal(req.url.searchParams.get("type"), "folder"); assert.equal(req.url.searchParams.get("async"), "true");
    folderDeletes++; return response(folderTask ? { task_id: folderTask } : {});
  };
  setHandler(folderHandler);
  const folderArgs = { folder: `https://team.feishu.cn/drive/folder/${folder}` };
  let inspection = await success("feishu_inspect_folder", folderArgs);
  let folderDelete = write({ ...folderArgs, expected_name: inspection.name, expected_snapshot_hash: inspection.snapshot_hash, delete_contents: false });
  const pending = await success("feishu_delete_folder", folderDelete);
  assert.equal(pending.state, "pending"); assert.equal(pending.deleted, false); assert.equal(pending.next_tool, "feishu_get_delete_task");
  assert.equal((await success("feishu_delete_folder", folderDelete)).replayed, true); assert.equal(folderDeletes, 1);
  rootId = folder;
  assert.equal((await call("feishu_delete_folder", write(folderDelete))).error, "invalid_input"); rootId = root;
  entries = [{ token: nested, name: "subfolder", type: "folder", parent_token: folder }, { token: "ShortcutRemaining", name: "link", type: "shortcut", parent_token: folder }];
  inspection = await success("feishu_inspect_folder", folderArgs); assert.equal(inspection.descendant_count, 3);
  folderDelete = write({ ...folderDelete, expected_snapshot_hash: inspection.snapshot_hash });
  assert.equal((await call("feishu_delete_folder", folderDelete)).error, "invalid_input");
  folderTask = "";
  assert.equal((await success("feishu_delete_folder", write({ ...folderDelete, delete_contents: true }))).deleted, true);
  entries[1].name = "Renamed link";
  assert.equal((await call("feishu_delete_folder", write({ ...folderDelete, delete_contents: true }))).error, "revision_conflict");
  malformedPages = true;
  assert.equal((await call("feishu_inspect_folder", folderArgs)).error, "resource_precheck_failed"); malformedPages = false;
  const beforeInvalid = requests.length;
  for (const value of ["https://evil.example/drive/folder/FolderRemainingTest", "https://team.feishu.cn/wiki/FolderRemainingTest", "root", "../FolderRemainingTest"]) assert.equal((await call("feishu_inspect_folder", { folder: value })).error, "invalid_input");
  assert.equal(requests.length, beforeInvalid); assert.equal(folderDeletes, 2);

  const wiki = "WikiRemainingTest", childId = "WikiRemainingChild", space = "7160145948494381236";
  let wikiNode = { node_token: wiki, space_id: space, title: "Disposable wiki", node_type: "origin", obj_token: "DocRemainingWiki", obj_type: "docx", has_child: true, parent_node_token: "", obj_edit_time: "100" };
  let wikiChild = { ...wikiNode, node_token: childId, title: "Child", obj_token: "DocRemainingChild", has_child: false, parent_node_token: wiki }, wikiDeletes = 0, wikiError = false;
  setHandler(req => {
    if (req.path.endsWith("node_by_token")) { assert.equal(req.url.searchParams.get("token"), wiki); return response({ node: wikiNode }); }
    if (req.method === "GET") { assert.equal(req.path, `/wiki/v2/spaces/${space}/nodes`); assert.equal(req.url.searchParams.get("parent_node_token"), wiki); return response({ items: [wikiChild], has_more: false }); }
    assert.equal(req.method, "DELETE"); assert.equal(req.path, `/wiki/v2/spaces/${space}/nodes/${wiki}`);
    assert.equal(req.body.obj_type, "wiki"); assert.equal(req.body.include_children, false); wikiDeletes++;
    return wikiError ? Response.json({ code: 131011, msg: "approval required" }) : response({ task_id: "wiki_task_123" });
  });
  const wikiArgs = { wiki: `https://team.feishu.cn/wiki/${wiki}`, include_children: false };
  const wikiRead = await success("feishu_inspect_wiki_node", wikiArgs);
  assert.equal(wikiRead.children_action, "lift_direct_children_to_parent");
  const wikiDelete = write({ ...wikiArgs, expected_title: wikiRead.node.title, expected_snapshot_hash: wikiRead.snapshot_hash });
  assert.equal((await success("feishu_delete_wiki_node", wikiDelete)).state, "pending");
  assert.equal((await success("feishu_delete_wiki_node", wikiDelete)).replayed, true); assert.equal(wikiDeletes, 1);
  assert.equal((await call("feishu_delete_wiki_node", write({ ...wikiDelete, include_children: true }))).error, "revision_conflict");
  wikiError = true;
  const approval = await call("feishu_delete_wiki_node", write(wikiDelete)); assert.equal(approval.error, "feishu_api_error"); assert.match(approval.message, /审批/);
  wikiNode = { ...wikiNode, node_type: "shortcut", has_child: false, origin_node_token: childId };
  const shortcut = await success("feishu_inspect_wiki_node", wikiArgs);
  assert.equal(shortcut.entries.length, 0);
  wikiError = false;
  assert.equal((await success("feishu_delete_wiki_node", write({ ...wikiDelete, expected_snapshot_hash: shortcut.snapshot_hash }))).node.node_token, wiki);
  wikiNode = { ...wikiNode, node_token: "DifferentWikiNode" };
  assert.equal((await call("feishu_inspect_wiki_node", wikiArgs)).error, "resource_precheck_failed");

  for (const scenario of ["drive", "wiki_node"]) {
    for (const [status, state] of [["success", "deleted"], ["failed", "failed"], ["processing", "pending"], ["unexpected", "unknown"], [undefined, "unknown"]]) {
      setHandler(req => {
        assert.equal(req.method, "GET");
        if (scenario === "drive") { assert.equal(req.path, "/drive/v1/files/task_check"); assert.equal(req.url.searchParams.get("task_id"), "test_task"); return response({ status }); }
        assert.equal(req.path, "/wiki/v2/tasks/test_task"); assert.equal(req.url.searchParams.get("task_type"), "delete_node");
        return response({ task: { task_id: "test_task", simple_task_result: { status } } });
      });
      const actual = await success("feishu_get_delete_task", { scenario, task_id: "test_task" });
      assert.equal(actual.state, state); assert.equal(actual.deleted, state === "deleted");
    }
  }
  setHandler(() => response({ task: { task_id: "other_task", simple_task_result: { status: "success" } } }));
  assert.equal((await call("feishu_get_delete_task", { scenario: "wiki_node", task_id: "test_task" })).error, "resource_precheck_failed");

  const document = "DoxRemainingSyntheticTest12", comment = "7696891164972027130", reply1 = "7696891164972027131", reply2 = "7696891164972027132";
  const makeReply = (id, text) => ({ reply_id: id, user_id: "ou_alice", content: { elements: [{ type: "text_run", text_run: { text } }] }, update_time: 100 });
  let replyItems = [makeReply(reply1, "First"), makeReply(reply2, "Second")], commentDeletes = [], failReply = "", unknownReply = "", insertReply = false, repeatCursor = false;
  const commentHandler = req => {
    if (req.path.endsWith("batch_query")) { assert.deepEqual(req.body.comment_ids, [comment]); return response({ items: [{ comment_id: comment, user_id: "ou_alice", is_whole: true, is_solved: false, update_time: 100 }] }); }
    if (req.method === "GET") {
      assert.equal(req.path, `/drive/v1/files/${document}/comments/${comment}/replies`);
      if (repeatCursor) return response({ items: [], has_more: true, page_token: "same" });
      if (!req.url.searchParams.has("page_token")) return response({ items: [], has_more: true, page_token: "replies +&page" });
      assert.equal(req.url.searchParams.get("page_token"), "replies +&page");
      return response({ items: replyItems, has_more: false });
    }
    const target = req.path.split("/").at(-1); assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined); assert.equal(req.url.searchParams.get("file_type"), "docx");
    commentDeletes.push(target);
    if (target === unknownReply) throw new Error("synthetic network uncertainty");
    if (target === failReply) return Response.json({ code: 1069302, msg: "synthetic reject" });
    replyItems = replyItems.filter(r => r.reply_id !== target);
    if (insertReply) { replyItems.push(makeReply("7696891164972027133", "Concurrent")); insertReply = false; }
    return response({});
  };
  setHandler(commentHandler);
  const commentArgs = { document, comment_id: comment };
  let commentRead = await success("feishu_get_document_comment", commentArgs);
  const oneReply = write({ ...commentArgs, reply_id: reply1, expected_reply_hash: commentRead.replies[0].reply_hash });
  replyItems[0].content.elements[0].text_run.text = "Changed";
  assert.equal((await call("feishu_delete_comment_reply", oneReply)).error, "revision_conflict"); assert.equal(commentDeletes.length, 0);
  replyItems[0] = makeReply(reply1, "First");
  assert.equal((await success("feishu_delete_comment_reply", write(oneReply))).scope, "single_reply"); assert.equal(replyItems.length, 1); assert.equal(replyItems[0].reply_id, reply2);
  replyItems = [makeReply(reply1, "First"), makeReply(reply2, "Second")]; commentDeletes = [];
  commentRead = await success("feishu_get_document_comment", commentArgs);
  let whole = write({ ...commentArgs, expected_comment_hash: commentRead.comment_hash });
  failReply = reply2;
  const partial = await success("feishu_delete_document_comment", whole);
  assert.equal(partial.state, "partial"); assert.equal(partial.deleted, false); assert.deepEqual(partial.deleted_reply_ids, [reply1]);
  assert.equal((await success("feishu_delete_document_comment", whole)).replayed, true); assert.deepEqual(commentDeletes, [reply1, reply2]);
  failReply = ""; commentRead = await success("feishu_get_document_comment", commentArgs);
  assert.equal((await success("feishu_delete_document_comment", write({ ...commentArgs, expected_comment_hash: commentRead.comment_hash }))).deleted, true);
  replyItems = [makeReply(reply1, "First")]; unknownReply = reply1;
  commentRead = await success("feishu_get_document_comment", commentArgs); whole = write({ ...commentArgs, expected_comment_hash: commentRead.comment_hash });
  assert.equal((await success("feishu_delete_document_comment", whole)).state, "unknown");
  const attempts = commentDeletes.length; assert.equal((await success("feishu_delete_document_comment", whole)).replayed, true); assert.equal(commentDeletes.length, attempts);
  unknownReply = ""; insertReply = true;
  const concurrent = await success("feishu_delete_document_comment", write(whole));
  assert.equal(concurrent.deleted, false); assert.equal(concurrent.state, "partial"); assert.deepEqual(concurrent.remaining_reply_ids, ["7696891164972027133"]);
  repeatCursor = true;
  assert.equal((await call("feishu_get_document_comment", commentArgs)).error, "resource_precheck_failed"); repeatCursor = false;

  const parent = "ParentRemainingTest", block1 = "BlockRemainingOne", block2 = "BlockRemainingTwo";
  let revision = 41, block = { block_id: parent, block_type: 1, children: [block1, block2] }, blockDeletes = 0, resultRevision = 42;
  setHandler(req => {
    if (req.method === "GET" && req.path === `/docx/v1/documents/${document}`) return response({ document: { revision_id: revision } });
    if (req.method === "GET") { assert.equal(req.url.searchParams.get("document_revision_id"), "41"); return response({ block }); }
    assert.equal(req.path, `/docx/v1/documents/${document}/blocks/${parent}/children/batch_delete`); assert.equal(req.method, "DELETE");
    assert.equal(req.url.searchParams.get("document_revision_id"), "41"); assert.match(req.url.searchParams.get("client_token"), /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(req.body, { start_index: 1, end_index: 2 }); blockDeletes++; return response({ document_revision_id: resultRevision });
  });
  const blockArgs = write({ document, parent_block_id: parent, expected_revision_id: 41, start_index: 1, end_index: 2, expected_block_ids: [block2] });
  assert.equal((await success("feishu_delete_document_blocks", blockArgs)).revision_id, 42);
  assert.equal((await success("feishu_delete_document_blocks", blockArgs)).replayed, true); assert.equal(blockDeletes, 1);
  revision = 42; assert.equal((await call("feishu_delete_document_blocks", write(blockArgs))).error, "revision_conflict"); revision = 41;
  assert.equal((await call("feishu_delete_document_blocks", write({ ...blockArgs, expected_block_ids: [block1] }))).error, "resource_precheck_failed");
  block.block_type = 31; assert.equal((await call("feishu_delete_document_blocks", write(blockArgs))).error, "invalid_input");
  block.block_type = 32; assert.equal((await call("feishu_delete_document_blocks", write({ ...blockArgs, start_index: 0, expected_block_ids: [block1, block2] }))).error, "invalid_input");
  block.block_type = 1; resultRevision = 41;
  const uncertain = write(blockArgs);
  assert.equal((await call("feishu_delete_document_blocks", uncertain)).error, "write_status_unknown");
  assert.equal((await call("feishu_delete_document_blocks", uncertain)).error, "write_status_unknown"); assert.equal(blockDeletes, 2);

  const beforeScope = requests.length;
  for (const [name, args] of [["feishu_delete_folder", folderDelete], ["feishu_delete_wiki_node", wikiDelete], ["feishu_delete_comment_reply", oneReply], ["feishu_delete_document_comment", whole], ["feishu_delete_document_blocks", blockArgs]]) {
    assert.equal((await call(name, write(args), "bob")).error, "additional_authorization_required");
    assert.equal((await rpc(name, write(args), "")).error, "authorization_required");
  }
  assert.equal(requests.length, beforeScope);
  console.log("PASS: remaining deletion scopes, complete snapshots, root/shortcut/range guards, partial and uncertain receipts, async status, user isolation and write replay");
}
