import assert from "node:assert/strict";

export async function fileStateCases({ success, call, response, requests, setHandler, sqlite, load }) {
  const { providerError } = await load("feishu");
  const errors = [
    [1770003, "/docx/v1/documents/Test/raw_content", "deleted"],
    [1002, "/bitable/v1/apps/Test/tables", "deleted"],
    [1002, "/sheets/v3/spreadsheets/Test/sheets/query", "deleted"],
    [1310249, "/sheets/v3/spreadsheets/Test/sheets/query", "deleted"],
    [1310214, "/sheets/v3/spreadsheets/Test/sheets/query", "not_found"],
    [1310249, "/im/v1/messages", undefined],
    [1310214, "/bitable/v1/apps/Test/tables", undefined],
    [1069304, "/drive/v1/files/Test/comments", "deleted"],
    [1770002, "/docx/v1/documents/Test", "not_found"],
    [1069307, "/drive/v1/files/Test/comments/Comment", "not_found"],
    [1069301, "/drive/v1/files/Test/comments/Comment", undefined],
    [1770032, "/docx/v1/documents/Test", undefined],
    [403, "/bitable/v1/apps/Test/tables", undefined],
    [404, "/bitable/v1/apps/Test/tables", undefined],
    [1002, "/im/v1/messages", undefined],
    [1002, undefined, undefined],
  ];
  for (const [code, path, state] of errors) {
    let error;
    try { providerError(new Response(null, { status: code === 403 ? 403 : 400, headers: { "x-tt-logid": "safe-trace-id" } }), { code, msg: "Upstream diagnostic; Bearer private-upstream-token" }, path && path + "?private=query"); }
    catch (value) { error = value; }
    assert.equal(error.kind, "feishu_api_error"); assert.equal(error.details.provider_code, code);
    assert.equal(error.details.resource_state, state); assert.equal(error.details.provider_request_id, "safe-trace-id");
    assert.equal(error.details.provider_path, path);
    assert.match(error.details.provider_message, /Upstream diagnostic/);
    if (state === "deleted") { assert.match(error.message, /已删除/); assert.doesNotMatch(error.message, /核对资源 ID 及连接状态/); assert.equal(error.details.retryable, false); }
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /private|Bearer/);
  }

  function diagnostic(msg, code = 87654321, credentials = []) {
    try { providerError(new Response(null, { status: 400 }), { code, msg, error: { access_token: "unselected-secret-field" } }, "/drive/v1/files/Test", credentials); }
    catch (error) { return error; }
    assert.fail("Expected a provider error");
  }
  assert.equal(diagnostic("New upstream explanation").details.provider_message, "New upstream explanation");
  assert.equal(diagnostic("access denied: scope drive:drive.metadata:readonly").details.provider_message, "access denied: scope drive:drive.metadata:readonly");
  for (const value of [null, 12, {}, [], "  "]) assert.equal(diagnostic(value).details.provider_message, undefined);
  const secrets = [
    'access_token="hidden-access-value"', '"refresh_token":"hidden-refresh-value"',
    'client_secret=hidden-client-value', 'app_secret: hidden-app-value',
    'Authorization: Bearer hidden-bearer-value', 'Cookie="hidden-cookie-value"',
    'https://cdn.feishu.cn/file?signature=hidden-url-value', 'u-hidden-feishu-value',
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJoaWRkZW4ifQ.hidden-signature',
    'Echoed credential without a label: hidden-known-value',
  ];
  for (const secret of secrets) {
    const result = diagnostic("Actionable explanation; " + secret, 87654321, ["hidden-known-value"]);
    assert.match(result.details.provider_message, /Actionable explanation/);
    assert.doesNotMatch(JSON.stringify(result.details), /hidden-|unselected-secret-field|eyJ/);
  }
  const long = diagnostic("x".repeat(1100));
  assert.equal(long.details.provider_message.length, 1001);
  assert.equal(diagnostic("clean\ntext\u202e").details.provider_message, "clean text");
  const quota = diagnostic("Quota exceeded", 99991403);
  assert.equal(quota.kind, "api_quota_exhausted"); assert.equal(quota.details.provider_message, "Quota exceeded");
  assert.equal(quota.details.provider_http_status, 400);

  let sequence = 0;
  for (const type of ["bitable", "sheet"]) {
    const id = "FileStateSynthetic", args = { file: id, file_type: type };
    const meta = { doc_token: id, doc_type: type, title: "Recycle then restore", latest_modify_time: "200" };
    const structurePath = type === "bitable" ? `/bitable/v1/apps/${id}/tables` : `/sheets/v3/spreadsheets/${id}/sheets/query`;
    let mode = "accessible", deleteCalls = 0, probeCalls = 0, asyncDelete = false;
    setHandler(req => {
      if (req.path === "/drive/v1/metas/batch_query") return response({ metas: [meta], failed_list: [] });
      if (req.method === "DELETE") { assert.equal(req.path, `/drive/v1/files/${id}`); deleteCalls++; return response(asyncDelete ? { task_id: "pending-file-state" } : {}); }
      assert.equal(req.path, structurePath); assert.equal(req.method, "GET"); probeCalls++;
      if (type === "bitable") assert.equal(req.url.searchParams.get("page_size"), "1");
      if (mode === "network") throw new Error("private provider network details");
      if (mode === "malformed") return response({});
      if (mode !== "accessible") return Response.json({ code: mode === "deleted" ? (type === "sheet" ? 1310249 : 1002) : mode === "not_found" ? (type === "sheet" ? 1310214 : 1770002) : 99991679, msg: "Resource diagnostic; Bearer private-provider-token" }, { status: mode === "denied" ? 403 : 400 });
      return response(type === "bitable" ? { items: [], has_more: false } : { sheets: [] });
    });
    let metadata = await success("feishu_get_file_metadata", args);
    assert.equal(metadata.resource_state, "accessible"); assert.equal(metadata.deleted, false); assert.equal(metadata.state_check.verified, true);
    const originalHash = metadata.metadata_hash;
    const deleteArgs = () => ({ ...args, expected_title: meta.title, expected_metadata_hash: originalHash, request_id: `file-state-${++sequence}` });
    mode = "deleted";
    metadata = await success("feishu_get_file_metadata", args);
    assert.equal(metadata.title, meta.title); assert.equal(metadata.metadata_hash, originalHash);
    assert.equal(metadata.resource_state, "deleted"); assert.equal(metadata.deleted, true);
    assert.equal(metadata.state_check.provider_code, type === "sheet" ? 1310249 : 1002); assert.equal(metadata.state_check.verified, true);
    assert.match(metadata.state_check.provider_message, /Resource diagnostic/);
    assert.match(metadata.metadata_note, /不能证明/);
    const rejected = deleteArgs();
    const refusal = await call("feishu_delete_file", rejected);
    assert.equal(refusal.error, "resource_deleted"); assert.equal(refusal.resource_state, "deleted"); assert.equal(deleteCalls, 0);
    const beforeReplay = requests.length;
    assert.deepEqual(await call("feishu_delete_file", rejected), refusal); assert.equal(requests.length, beforeReplay);

    // Restore the same file without changing its metadata: recheck the real
    // resource, rather than using a cached deletion receipt or the hash.
    mode = "accessible"; metadata = await success("feishu_get_file_metadata", args);
    assert.equal(metadata.resource_state, "accessible"); assert.equal(metadata.deleted, false); assert.equal(metadata.metadata_hash, originalHash);

    for (mode of ["denied", "not_found", "network", "malformed"]) {
      metadata = await success("feishu_get_file_metadata", args);
      assert.equal(metadata.resource_state, mode === "not_found" ? "not_found" : "unknown"); assert.equal(metadata.deleted, null);
      assert.equal(metadata.state_check.verified, mode === "not_found"); assert.equal(metadata.state_check.attempted, true);
      assert.doesNotMatch(JSON.stringify(metadata), /private.provider/);
    }

    const saved = sqlite.prepare("SELECT scope FROM feishu_connections WHERE user_id='alice'").get().scope;
    const readScope = type === "bitable" ? "bitable:app:readonly" : "sheets:spreadsheet:readonly";
    const writeScope = type === "bitable" ? "bitable:app" : "sheets:spreadsheet";
    const limited = saved.split(" ").filter(scope => ![readScope, writeScope].includes(scope)).join(" ");
    sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(limited);
    try {
      const beforeProbe = probeCalls;
      metadata = await success("feishu_get_file_metadata", args);
      assert.equal(metadata.resource_state, "unknown"); assert.equal(metadata.deleted, null);
      assert.equal(metadata.state_check.attempted, false); assert.equal(metadata.state_check.reason, "additional_authorization_required");
      assert.equal(probeCalls, beforeProbe);
      // Metadata + Drive delete permission still works without an optional
      // table-specific read grant; this fix must not expand required scopes.
      const deleted = await success("feishu_delete_file", deleteArgs());
      assert.equal(deleted.deleted, true); assert.equal(deleted.resource_state, "deleted");
      assert.equal(deleted.state_check.source, "delete_response"); assert.equal(deleted.destination, "recycle_bin");
      assert.equal(sqlite.prepare("SELECT scope FROM feishu_connections WHERE user_id='alice'").get().scope, limited);
    } finally { sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(saved); }
    mode = "accessible"; asyncDelete = true;
    const pending = await success("feishu_delete_file", deleteArgs());
    assert.equal(pending.state, "pending"); assert.equal(pending.resource_state, "unknown"); assert.equal(pending.state_check.verified, false);
  }
  for (const type of ["slides"]) {
    setHandler(req => { assert.equal(req.path, "/drive/v1/metas/batch_query"); return response({ metas: [{ doc_token: "MetadataOnly", doc_type: type, title: "Metadata only", latest_modify_time: "200" }] }); });
    const metadata = await success("feishu_get_file_metadata", { file: "MetadataOnly", file_type: type });
    assert.equal(metadata.resource_state, "unknown"); assert.equal(metadata.deleted, null); assert.equal(metadata.state_check.attempted, false);
  }
  // Ordinary files use the documented download response, not surviving Drive
  // metadata. A 404 confirms not_found, not deletion. Do not consume the body.
  const fileArgs = { file: "DownloadStateSynthetic", file_type: "file" };
  let mode = "accessible", cancelled = 0, downloads = 0;
  setHandler(req => {
    if (req.path === "/drive/v1/metas/batch_query") return response({ metas: [{ doc_token: fileArgs.file, doc_type: "file", title: "Uploaded CSV", latest_modify_time: "200" }] });
    assert.equal(req.path, `/drive/v1/files/${fileArgs.file}/download`); assert.equal(req.method, "GET"); downloads++;
    if (mode === "missing") return new Response(null, { status: 404, headers: { "x-tt-logid": "file-missing-trace" } });
    if (mode === "denied") return Response.json({ code: 99991679, msg: "Access denied", error: { permission_violations: [{ subject: "drive:drive:readonly" }] } }, { status: 403 });
    if (mode === "network") throw new Error("private provider network detail");
    return new Response(new ReadableStream({ pull() { assert.fail("State checks must not consume file bytes"); }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/csv", "content-length": "1000000000" } });
  });
  const first = await success("feishu_get_file_metadata", fileArgs);
  assert.equal(first.resource_state, "accessible"); assert.equal(first.deleted, false); assert.equal(cancelled, 1);
  assert.equal(first.state_check.source, "file_download");
  mode = "missing";
  const missing = await success("feishu_get_file_metadata", fileArgs);
  assert.equal(missing.resource_state, "not_found"); assert.equal(missing.deleted, null); assert.equal(missing.state_check.verified, true);
  assert.equal(missing.state_check.provider_http_status, 404); assert.equal(missing.state_check.provider_request_id, "file-missing-trace");
  assert.match(missing.state_check.message, /不能区分/); assert.equal(missing.metadata_hash, first.metadata_hash);
  for (mode of ["denied", "network"]) {
    const result = await success("feishu_get_file_metadata", fileArgs);
    assert.equal(result.resource_state, "unknown"); assert.equal(result.deleted, null); assert.equal(result.state_check.verified, false);
    if (mode === "denied") { assert.equal(result.state_check.provider_message, "Access denied"); assert.deepEqual(result.state_check.provider_required_scopes, ["drive:drive:readonly"]); }
  }
  mode = "accessible";
  assert.equal((await success("feishu_get_file_metadata", fileArgs)).resource_state, "accessible"); assert.equal(cancelled, 2);
  const saved = sqlite.prepare("SELECT scope FROM feishu_connections WHERE user_id='alice'").get().scope;
  const limited = saved.split(" ").filter(scope => !["drive:drive:readonly", "drive:drive"].includes(scope)).join(" ");
  sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(limited);
  try {
    const before = downloads;
    const result = await success("feishu_get_file_metadata", fileArgs);
    assert.equal(result.resource_state, "unknown"); assert.equal(result.state_check.attempted, false); assert.equal(downloads, before);
  } finally { sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(saved); }
  console.log("PASS: documented deletion errors, safe diagnostics, retained metadata vs actual table state, restore rechecks, unknown/permission/network states, unchanged grants and no repeated deletes");
}
