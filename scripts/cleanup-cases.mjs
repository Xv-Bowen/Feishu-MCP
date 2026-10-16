import assert from "node:assert/strict";

export async function cleanupCases({ success, call, rpc, response, requests, setHandler, load }) {
  let sequence = 0;
  const write = value => ({ ...value, request_id: `cleanup-case-${++sequence}` });
  const deletionTools = ["feishu_delete_file", "feishu_delete_calendar_event", "feishu_delete_bitable_record", "feishu_delete_bitable_table"];
  const tools = (await load("workspace-tools")).WORKSPACE_TOOLS;
  for (const name of deletionTools) {
    const tool = tools.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.ok(tool.inputSchema.required.includes("request_id"));
  }

  // Whole-file types must use Drive deletion, never a worksheet API.
  const fileToken = "FileCleanupSynthetic";
  let fileArgs, fileMeta, metadata;
  for (const [type, path] of [["sheet", "sheets"], ["bitable", "base"], ["slides", "slides"], ["file", "file"]]) {
    fileArgs = { file: `https://team.feishu.cn/${path}/${fileToken}`, file_type: type };
    fileMeta = { doc_token: fileToken, doc_type: type, title: `Cleanup ${type}`, owner_id: "ou_alice", create_time: "100", latest_modify_time: "200", latest_modify_user: "ou_alice" };
    let deletes = 0;
    setHandler(req => {
      if (req.path === "/drive/v1/metas/batch_query") {
        assert.equal(req.method, "POST"); assert.equal(req.url.searchParams.get("user_id_type"), "open_id");
        assert.deepEqual(req.body, { request_docs: [{ doc_token: fileToken, doc_type: type }], with_url: true });
        return response({ metas: [fileMeta], failed_list: [] });
      }
      if (req.method === "GET") {
        if (type === "file") { assert.equal(req.path, `/drive/v1/files/${fileToken}/download`); return new Response("test", { headers: { "content-type": "text/plain" } }); }
        assert.equal(req.path, type === "sheet" ? `/sheets/v3/spreadsheets/${fileToken}/sheets/query` : `/bitable/v1/apps/${fileToken}/tables`);
        return response(type === "sheet" ? { sheets: [] } : { items: [], has_more: false });
      }
      assert.equal(req.path, `/drive/v1/files/${fileToken}`); assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined);
      assert.equal(req.url.searchParams.get("type"), type); assert.equal(req.url.searchParams.get("async"), "false");
      deletes++; return response({});
    });
    metadata = await success("feishu_get_file_metadata", fileArgs);
    assert.equal(metadata.title, fileMeta.title); assert.match(metadata.metadata_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(metadata.resource_state, type === "slides" ? "unknown" : "accessible");
    const args = write({ ...fileArgs, expected_title: metadata.title, expected_metadata_hash: metadata.metadata_hash });
    assert.equal((await success("feishu_delete_file", args)).destination, "recycle_bin");
    assert.equal((await success("feishu_delete_file", args)).replayed, true); assert.equal(deletes, 1);
    assert.equal((await call("feishu_delete_file", write({ ...args, expected_title: "Different title" }))).error, "revision_conflict");
    fileMeta.latest_modify_time = "201";
    assert.equal((await call("feishu_delete_file", write(args))).error, "revision_conflict"); assert.equal(deletes, 1);
  }
  const fileDelete = { ...fileArgs, expected_title: metadata.title, expected_metadata_hash: metadata.metadata_hash };
  const invalidBefore = requests.length;
  for (const override of [{ file_type: "folder" }, { file_type: "docx" }, { file_type: "wiki" }, { file: "https://team.feishu.cn/wiki/WikiCleanup" }, { file: `https://evil.example/file/${fileToken}` }, { file: `https://team.feishu.cn/sheets/${fileToken}` }, { expected_metadata_hash: null }]) {
    assert.equal((await call("feishu_delete_file", write({ ...fileDelete, ...override }))).error, "invalid_input");
  }
  assert.equal(requests.length, invalidBefore);
  for (const data of [{ metas: [] }, { metas: [{ ...fileMeta, doc_type: "sheet" }] }, { metas: [{ ...fileMeta, latest_modify_time: null }] }, { metas: [fileMeta], failed_list: [{ token: fileToken, code: 403 }] }]) {
    setHandler(req => { assert.equal(req.path, "/drive/v1/metas/batch_query"); return response(data); });
    assert.equal((await call("feishu_delete_file", write(fileDelete))).error, "resource_precheck_failed");
  }
  fileMeta.latest_modify_time = "200";
  setHandler(req => req.method === "POST" ? response({ metas: [fileMeta] }) : response({ task_id: "async-cleanup" }));
  const pendingArgs = write(fileDelete), pending = await success("feishu_delete_file", pendingArgs);
  assert.equal(pending.state, "pending"); assert.equal(pending.deleted, false);
  assert.equal((await success("feishu_delete_file", pendingArgs)).replayed, true);
  let uncertain = 0;
  setHandler(req => { if (req.method === "POST") return response({ metas: [fileMeta] }); if (req.method === "GET") return new Response("test"); uncertain++; throw new Error("connection lost after DELETE"); });
  const uncertainArgs = write(fileDelete);
  assert.equal((await call("feishu_delete_file", uncertainArgs)).error, "write_status_unknown");
  assert.equal((await call("feishu_delete_file", uncertainArgs)).error, "write_status_unknown"); assert.equal(uncertain, 1);

  const calendar = "calendar_cleanup@group.calendar.feishu.cn", id = "cleanup-event_0";
  let event = { event_id: id, summary: "Only this event", start_time: { timestamp: "1792022400" }, end_time: { timestamp: "1792024200" }, status: "confirmed", recurrence: "" };
  const eventHash = (await load("calendars")).eventHash;
  let calendarDeletes = 0;
  setHandler(req => {
    assert.equal(req.path, `/calendar/v4/calendars/${encodeURIComponent(calendar)}/events/${event.event_id}`);
    if (req.method === "GET") return response({ event });
    assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined); assert.equal(req.url.searchParams.get("need_notification"), "false");
    calendarDeletes++; return response({});
  });
  const calendarArgs = { calendar_id: calendar, event_id: id, expected_event_hash: await eventHash(event), delete_scope: "single" };
  const eventRequest = write(calendarArgs);
  assert.equal((await success("feishu_delete_calendar_event", eventRequest)).deleted, true);
  assert.equal((await success("feishu_delete_calendar_event", eventRequest)).replayed, true); assert.equal(calendarDeletes, 1);
  event.summary = "Changed";
  assert.equal((await call("feishu_delete_calendar_event", write(calendarArgs))).error, "revision_conflict");
  event.recurrence = "FREQ=DAILY;COUNT=3";
  const seriesArgs = { ...calendarArgs, expected_event_hash: await eventHash(event) };
  assert.equal((await call("feishu_delete_calendar_event", write(seriesArgs))).error, "invalid_input"); assert.equal(calendarDeletes, 1);
  assert.equal((await success("feishu_delete_calendar_event", write({ ...seriesArgs, delete_scope: "series" }))).delete_scope, "series");
  event.event_id = "cleanup-event_1792022400";
  const instanceArgs = { ...calendarArgs, event_id: event.event_id, expected_event_hash: await eventHash(event) };
  assert.equal((await call("feishu_delete_calendar_event", write({ ...instanceArgs, delete_scope: "series" }))).error, "invalid_input");
  assert.equal((await success("feishu_delete_calendar_event", write(instanceArgs))).event_id, event.event_id);
  event.status = "cancelled";
  const beforeCancelled = calendarDeletes;
  assert.equal((await success("feishu_delete_calendar_event", write({ ...instanceArgs, expected_event_hash: await eventHash(event) }))).state, "already_cancelled");
  assert.equal(calendarDeletes, beforeCancelled);
  setHandler(req => { assert.equal(req.method, "GET"); return response({ event: { ...event, event_id: "another-event_0" } }); });
  assert.equal((await call("feishu_delete_calendar_event", write(instanceArgs))).error, "resource_precheck_failed");

  const app = "BitableCleanupSynthetic", table = "tblCleanup", recordId = "recCleanup", recordArgs = { app, table_id: table, record_id: recordId };
  let record = { record_id: recordId, fields: { Name: "Only this record", Number: 3, Attachment: [{ file_token: "AttachmentSynthetic", name: "test.csv", tmp_url: "https://download.example/old" }] }, last_modified_time: 123 };
  let recordDeletes = 0;
  setHandler(req => {
    assert.equal(req.path, `/bitable/v1/apps/${app}/tables/${table}/records/${recordId}`);
    if (req.method === "GET") { assert.equal(req.url.searchParams.get("automatic_fields"), "true"); return response({ record }); }
    assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined); assert.equal(req.url.searchParams.get("ignore_consistency_check"), "false");
    recordDeletes++; return response({ deleted: true, record_id: recordId });
  });
  const read = await success("feishu_get_bitable_record", recordArgs);
  const recordRequest = write({ ...recordArgs, expected_record_hash: read.record_hash });
  record.fields = { Attachment: [{ name: "test.csv", tmp_url: "https://download.example/refreshed", file_token: "AttachmentSynthetic" }], Number: 3, Name: "Only this record" };
  assert.equal((await success("feishu_delete_bitable_record", recordRequest)).deleted, true);
  assert.equal((await success("feishu_delete_bitable_record", recordRequest)).replayed, true); assert.equal(recordDeletes, 1);
  record.fields.Number = 4;
  assert.equal((await call("feishu_delete_bitable_record", write(recordRequest))).error, "revision_conflict"); assert.equal(recordDeletes, 1);
  record.fields.Number = 3;
  setHandler(req => { if (req.method === "GET") return response({ record }); recordDeletes++; return response({ deleted: true, record_id: "recOther" }); });
  const wrongReceipt = write(recordRequest);
  assert.equal((await call("feishu_delete_bitable_record", wrongReceipt)).error, "write_status_unknown");
  assert.equal((await call("feishu_delete_bitable_record", wrongReceipt)).error, "write_status_unknown"); assert.equal(recordDeletes, 2);

  let tableDeletes = 0, tableData = { table_id: table, name: "Only this table", revision: 3 };
  setHandler(req => {
    if (req.method === "GET") {
      assert.equal(req.path, `/bitable/v1/apps/${app}/tables`); assert.equal(req.url.searchParams.get("page_size"), "100");
      return req.url.searchParams.get("page_token") ? response({ items: [tableData], has_more: false }) : response({ items: [], has_more: true, page_token: "next + & page" });
    }
    assert.equal(req.path, `/bitable/v1/apps/${app}/tables/${table}`); assert.equal(req.method, "DELETE"); assert.equal(req.body, undefined);
    tableDeletes++; return response({});
  });
  const tableArgs = { app, table_id: table, expected_name: tableData.name, expected_revision: 3 }, tableRequest = write(tableArgs);
  assert.equal((await success("feishu_delete_bitable_table", tableRequest)).includes_all_records, true);
  assert.equal((await success("feishu_delete_bitable_table", tableRequest)).replayed, true); assert.equal(tableDeletes, 1);
  tableData.revision++;
  assert.equal((await call("feishu_delete_bitable_table", write(tableArgs))).error, "revision_conflict"); assert.equal(tableDeletes, 1);
  setHandler(req => { assert.equal(req.method, "GET"); return response({ items: [], has_more: true, page_token: "loop" }); });
  assert.equal((await call("feishu_delete_bitable_table", write(tableArgs))).error, "resource_precheck_failed");

  const beforeScope = requests.length;
  for (const [name, args] of [[deletionTools[0], fileDelete], [deletionTools[1], calendarArgs], [deletionTools[2], recordRequest], [deletionTools[3], tableArgs]]) {
    assert.equal((await call(name, write(args), "bob")).error, "additional_authorization_required");
    assert.equal((await rpc(name, write(args), "")).error, "authorization_required");
  }
  assert.equal(requests.length, beforeScope, "Missing authorization must prevent all provider calls");
  console.log("PASS: whole-file cleanup for sheets/Bitable/uploads/slides; event/series/instance isolation and explicit no-notification; record/table cleanup; metadata/version guards, pagination, scope checks, pending/unknown results and encrypted replay");
}
