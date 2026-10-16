import { AppError, safeMessage } from "./core";
import { accessToken, type Runtime } from "./feishu";
import { callApi } from "./integration-common";
import { resourceResponse } from "./resources";

// Drive metadata can survive recycling. Use a read of the actual resource
// when the caller already has the matching grant, without changing scopes or
// consuming file content. Never use a remembered delete receipt as current state:
// the user may since have restored the file in Feishu.
export async function fileAvailability(env: Runtime, user: string, id: string, type: string) {
  const probe = type === "bitable" ? { scope: "bitable:app:readonly", path: `/bitable/v1/apps/${id}/tables?page_size=1`, source: "bitable_tables" }
    : type === "sheet" ? { scope: "sheets:spreadsheet:readonly", path: `/sheets/v3/spreadsheets/${id}/sheets/query`, source: "sheet_list" }
    : type === "file" ? { scope: "drive:drive:readonly", path: `/drive/v1/files/${id}/download`, source: "file_download" } : null;
  if (!probe) return { resource_state: "unknown", deleted: null, state_check: { verified: false, attempted: false, source: "metadata_only", reason: "no_lifecycle_check", message: "此文件类型当前仅核对元数据，尚未确认是否已删除。" } };
  let attempted = false;
  try {
    const token = await accessToken(env, user, [probe.scope]);
    attempted = true;
    if (type === "file") {
      const response = await resourceResponse(env, user, { resource_token: id, kind: "file" });
      // Check the download response, then cancel without reading/saving the file.
      await response.body?.cancel();
    } else {
      const data = await callApi(token, probe.path);
      const valid = type === "bitable" ? Array.isArray(data.items) && typeof data.has_more === "boolean" : Array.isArray(data.sheets);
      if (!valid) throw new AppError("resource_state_unverified", "文件状态核验接口未返回有效的结构列表。", 502);
    }
    return { resource_state: "accessible", deleted: false, state_check: { verified: true, attempted, source: probe.source, checked_at: new Date().toISOString() } };
  } catch (error) {
    // A changed/revoked connection must still stop an in-flight write.
    if (error instanceof AppError && ["connection_required", "connection_changed", "reauthorization_required", "refresh_in_progress"].includes(error.kind)) throw error;
    const details = error instanceof AppError ? error.details : undefined;
    const deleted = details?.resource_state === "deleted";
    const notFound = details?.resource_state === "not_found";
    const missingReadScope = error instanceof AppError && error.kind === "additional_authorization_required";
    return {
      resource_state: deleted ? "deleted" : notFound ? "not_found" : "unknown", deleted: deleted ? true : null,
      state_check: { verified: deleted || notFound, attempted, source: probe.source, checked_at: new Date().toISOString(), reason: error instanceof AppError ? error.kind : "service_error", message: missingReadScope ? "已取得文件元数据，但缺少可选的资源读取权限，未核验文件存活状态。" : safeMessage(error), ...(missingReadScope ? { scope_for_state_check: probe.scope } : {}), ...(typeof details?.provider_code === "number" ? { provider_code: details.provider_code } : {}), ...(typeof details?.provider_http_status === "number" ? { provider_http_status: details.provider_http_status } : {}), ...(typeof details?.provider_message === "string" ? { provider_message: details.provider_message } : {}), ...(typeof details?.provider_request_id === "string" ? { provider_request_id: details.provider_request_id } : {}), ...(Array.isArray(details?.provider_required_scopes) ? { provider_required_scopes: details.provider_required_scopes } : {}), ...(attempted ? { provider_path: probe.path.split("?")[0] } : {}) },
    };
  }
}
