import assert from "node:assert/strict";

export async function metadataPermissionCases({ success, call, requests, response, setHandler, sqlite, load, env }) {
  const scope = "drive:drive.metadata:readonly";
  const saved = sqlite.prepare("SELECT scope FROM feishu_connections WHERE user_id='alice'").get().scope;
  const oldGrant = saved.split(" ").filter(value => value !== scope);
  assert.ok(oldGrant.includes("drive:drive:readonly"));
  sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(oldGrant.join(" "));
  try {
    const state = await success("feishu_connection_status");
    assert.deepEqual(state.missing_feature_scopes, [scope]);
    assert.equal(state.features.find(feature => feature.id === "document_delete").ready, false);
    assert.equal(state.features.find(feature => feature.id === "file_metadata").ready, false);
    assert.equal(state.permission_check.live_api_verified, false);
    assert.deepEqual(state.base_scopes, state.scopes);
    assert.ok(state.granted_scopes.length > state.base_scopes.length);
    const before = requests.length;
    setHandler(() => { throw new Error("No provider call is allowed without the metadata grant"); });
    for (const file_type of ["sheet", "bitable", "file"]) {
      const args = { file: "PermissionSynthetic", file_type };
      const denied = await call("feishu_get_file_metadata", args);
      assert.equal(denied.error, "additional_authorization_required");
      assert.deepEqual(denied.missing_scopes, [scope]);
      assert.ok(denied.message.includes(scope));
      const deletion = await call("feishu_delete_file", { ...args, expected_title: "Test", expected_metadata_hash: "a".repeat(43), request_id: `metadata-denied-${file_type}` });
      assert.deepEqual(deletion.missing_scopes, [scope]);
    }
    const folder = await call("feishu_inspect_folder", { folder: "FolderPermissionSynthetic" });
    assert.deepEqual(folder.missing_scopes, [scope]);
    assert.equal(requests.length, before);
    const feishu = await load("feishu");
    const auth = new URL(await feishu.startAuthorization(env, "alice", ["document_delete"]));
    assert.ok(auth.searchParams.get("scope").split(" ").includes(scope), "Supplemental OAuth must actually request the new scope");
  } finally {
    sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(saved);
  }

  // Once granted, read-only preflight must return a real identity and hash.
  for (const file_type of ["sheet", "bitable", "file"]) {
    setHandler(req => {
      if (req.method === "GET") {
        if (file_type === "file") { assert.equal(req.path, "/drive/v1/files/PermissionSynthetic/download"); return new Response("test", { headers: { "content-type": "text/plain" } }); }
        assert.equal(req.path, file_type === "sheet" ? "/sheets/v3/spreadsheets/PermissionSynthetic/sheets/query" : "/bitable/v1/apps/PermissionSynthetic/tables");
        return response(file_type === "sheet" ? { sheets: [] } : { items: [], has_more: false });
      }
      assert.equal(req.path, "/drive/v1/metas/batch_query");
      assert.equal(req.method, "POST");
      assert.deepEqual(req.body.request_docs, [{ doc_token: "PermissionSynthetic", doc_type: file_type }]);
      return response({ metas: [{ doc_token: "PermissionSynthetic", doc_type: file_type, title: "Authorized test", latest_modify_time: "200" }] });
    });
    const metadata = await success("feishu_get_file_metadata", { file: "PermissionSynthetic", file_type });
    assert.equal(metadata.title, "Authorized test");
    assert.match(metadata.metadata_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(metadata.resource_state, "accessible");
  }

  // A locally recorded grant cannot prove current provider authorization.
  // Preserve the permission options and trace ID when Feishu still rejects it.
  for (const code of [99991679, 99991672]) {
    setHandler(() => Response.json({ code, msg: "Access denied; Bearer private-upstream-token", error: { log_id: "metadata-permission-log", permission_violations: [{ subject: scope, description: "private request data" }, { subject: scope }, { subject: "Bearer secret" }], access_token: "must-not-escape" } }, { status: 403 }));
    const denied = await call("feishu_get_file_metadata", { file: "PermissionSynthetic", file_type: "file" });
    assert.equal(denied.provider_code, code);
    assert.equal(denied.provider_request_id, "metadata-permission-log");
    assert.equal(denied.provider_path, "/drive/v1/metas/batch_query");
    assert.deepEqual(denied.provider_required_scopes, [scope]);
    assert.deepEqual(denied.provider_permission_violations, [{ subject: scope }]);
    assert.equal(denied.permission_layer, code === 99991679 ? "user" : "app");
    assert.equal(denied.reauthorization_required, code === 99991679);
    assert.ok(denied.message.includes(scope));
    assert.match(denied.provider_message, /Access denied/);
    assert.doesNotMatch(JSON.stringify(denied), /must-not-escape|private.upstream|private request|Bearer secret/);
  }
}
