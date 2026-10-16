import { AppError, documentId } from "./core";
import { DRIVE_METADATA_SCOPE } from "./features";
import { type Runtime } from "./feishu";
import { fileAvailability } from "./file-state";
import { eventHash } from "./calendars";
import { sha256 } from "./crypto";
import { boolField, callApi, enumField, integration, obj, queryPath } from "./integration-common";
import { canonical, identifier, resourceToken, stringField, type Arguments } from "./workspace-common";

const filePaths: Record<string, string[]> = { sheet: ["sheets"], bitable: ["base", "bitable"], file: ["file"], slides: ["slides"] };
const fileFields = {
  file: stringField("云空间电子表格、多维表格、上传文件或幻灯片的链接/token；不接受知识库或文件夹链接"),
  file_type: enumField(Object.keys(filePaths), "sheet=整份电子表格，bitable=整个多维表格，file=上传文件，slides=整份幻灯片；不是内部工作表或记录"),
};
const hashField = (description: string) => ({ ...stringField(description, 43), pattern: "^[A-Za-z0-9_-]{43}$" });
async function fileMetadata(token: string, a: Arguments, env: Runtime, user: string) {
  const type = String(a.file_type), id = resourceToken(a.file, filePaths[type]);
  const data = await callApi(token, "/drive/v1/metas/batch_query?user_id_type=open_id", { request_docs: [{ doc_token: id, doc_type: type }], with_url: true });
  const matches = Array.isArray(data.metas) ? data.metas.map(obj).filter(item => item.doc_token === id && item.doc_type === type) : [];
  const meta = matches[0];
  if (matches.length !== 1 || !meta || typeof meta.title !== "string" || !/^\d+$/.test(String(meta.latest_modify_time)) || (Array.isArray(data.failed_list) && data.failed_list.some(item => obj(item).token === id))) {
    throw new AppError("resource_precheck_failed", "无法核对文件类型、标题和修改时间；请检查链接及读取权限。未执行删除。", 502);
  }
  const identity = { file_token: id, file_type: type, title: meta.title, owner_id: meta.owner_id ?? null, create_time: meta.create_time ?? null, latest_modify_time: String(meta.latest_modify_time), latest_modify_user: meta.latest_modify_user ?? null };
  return { ...identity, url: meta.url ?? null, metadata_hash: await sha256(canonical(identity)), ...await fileAvailability(env, user, id, type), metadata_note: "标题和 metadata_hash 仅用于核对文件身份与元数据变化，不能证明文件仍存在或可用。请结合 resource_state 和 state_check；not_found 表示接口未找到，不等于确认删除；unknown 表示尚未核验。deleted 为 null 时不能推断已删除或未删除。" };
}
const bitableFields = { app: stringField("多维表格 /base/ 链接或 app_token"), table_id: stringField("数据表 table_id", 100) };
const recordFields = { ...bitableFields, record_id: stringField("记录 record_id", 100) };
function tableRoot(a: Arguments) {
  const app = resourceToken(a.app, ["base", "bitable"]), table = identifier(a.table_id, "数据表 ID", /^tbl[A-Za-z0-9_-]{3,100}$/);
  return { app, table, root: `/bitable/v1/apps/${app}/tables/${table}` };
}
function stableRecordFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRecordFields);
  if (!value || typeof value !== "object") return value;
  const item = value as Arguments;
  // Attachment download URLs expire/rotate without editing the record. The
  // immutable file_token and other attachment properties identify its content.
  return Object.fromEntries(Object.entries(item).filter(([key]) => !(typeof item.file_token === "string" && ["tmp_url", "url"].includes(key))).map(([key, child]) => [key, stableRecordFields(child)]));
}
export async function bitableRecordHash(record: Arguments) { return sha256(canonical({ record_id: record.record_id, fields: stableRecordFields(record.fields), last_modified_time: record.last_modified_time ?? null })); }
async function readRecord(token: string, a: Arguments) {
  const { root } = tableRoot(a), id = identifier(a.record_id, "记录 ID", /^rec[A-Za-z0-9_-]{3,100}$/);
  const record = obj((await callApi(token, `${root}/records/${id}?user_id_type=open_id&automatic_fields=true`)).record);
  if (record.record_id !== id || !record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) throw new AppError("resource_precheck_failed", "未取得指定记录的完整字段，未执行删除。", 502);
  return { record, record_hash: await bitableRecordHash(record) };
}
async function readTable(token: string, a: Arguments) {
  const { app, table } = tableRoot(a);
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const data = await callApi(token, queryPath(`/bitable/v1/apps/${app}/tables`, { page_size: 100, page_token: cursor }));
    if (!Array.isArray(data.items)) break;
    const found = data.items.map(obj).find(item => item.table_id === table);
    if (found && typeof found.name === "string" && Number.isInteger(found.revision)) return found;
    if (data.has_more !== true) break;
    if (typeof data.page_token !== "string" || !data.page_token || seen.has(data.page_token)) break;
    seen.add(data.page_token); cursor = data.page_token;
  }
  throw new AppError("resource_precheck_failed", "未能在多维表格中核对指定数据表，未执行删除。请检查数据表 ID 和读取权限。", 404);
}

export const DELETION_INTEGRATIONS = [
  integration("feishu_get_file_metadata", "核对云空间文件", "读取整份电子表格、多维表格、上传文件或幻灯片的身份元数据及 metadata_hash。标题和 hash 不证明文件未删除；结合 resource_state/state_check。已有读取权限时核验表格结构或上传文件的下载响应，不读取文件、记录或单元格正文。not_found 不等于确认删除，无法核验则为 unknown。删除整份文件前先核对。", fileFields, ["file", "file_type"], [DRIVE_METADATA_SCOPE], async (e, u, a, token) => fileMetadata(token, a, e, u)),
  integration("feishu_delete_file", "删除整份表格、上传文件或幻灯片", "仅按用户明确要求，将整份电子表格、整个多维表格、上传文件或幻灯片移入回收站，内部工作表/数据表/记录随整个文件删除。先用 feishu_get_file_metadata 核对准确标题和 metadata_hash。云空间 docx 使用 feishu_delete_document；不接受知识库节点或文件夹。", {
    ...fileFields, expected_title: { ...stringField("元数据工具返回的准确标题", 1000), minLength: 0 }, expected_metadata_hash: hashField("元数据工具返回的 metadata_hash"),
  }, ["file", "file_type", "expected_title", "expected_metadata_hash"], [DRIVE_METADATA_SCOPE, "space:document:delete"], async (e, u, a, token) => {
    const current = await fileMetadata(token, a, e, u);
    if (current.resource_state === "deleted") throw new AppError("resource_deleted", "飞书已确认该文件被删除；未再次提交删除。", 410, { file_token: current.file_token, file_type: current.file_type, resource_state: "deleted", state_check: current.state_check });
    if (current.title !== a.expected_title || current.metadata_hash !== a.expected_metadata_hash) throw new AppError("revision_conflict", "文件标题或元数据已变化，请重新读取并核对删除目标。", 409);
    const result = await callApi(token, queryPath(`/drive/v1/files/${current.file_token}`, { type: current.file_type, async: false }), undefined, "DELETE");
    if (result.task_id) return { ...current, resource_state: "unknown", state_check: { verified: false, source: "delete_response", reason: "pending" }, deleted: false, state: "pending", task_id: result.task_id, next_tool: "feishu_get_delete_task", next_arguments: { scenario: "drive", task_id: result.task_id }, note: "飞书已受理异步删除；继续查询任务，不要重复提交。" };
    return { ...current, resource_state: "deleted", state_check: { verified: true, source: "delete_response" }, deleted: true, state: "deleted", destination: "recycle_bin" };
  }, true, true),
  integration("feishu_delete_calendar_event", "删除日程", "删除用户明确指定的日程。先读取详情核对 expected_event_hash，并明确 delete_scope：single 为普通日程或单次实例，series 为整个重复系列。不会把实例自动扩大为整个系列。默认不发送日历通知，只有明确要求通知时设置 need_notification=true。", {
    calendar_id: stringField("日历 ID", 200), event_id: stringField("详情返回的准确 event_id", 200), expected_event_hash: hashField("日程详情返回的 event_hash"), delete_scope: enumField(["single", "series"]), need_notification: boolField,
  }, ["calendar_id", "event_id", "expected_event_hash", "delete_scope"], ["calendar:calendar"], async (_e, _u, a, token) => {
    const calendar = identifier(a.calendar_id, "日历 ID", /^[A-Za-z0-9_.@+-]{8,200}$/), id = identifier(a.event_id, "日程 ID", /^[A-Za-z0-9_.@+-]{8,200}$/);
    const root = `/calendar/v4/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`;
    const current = obj((await callApi(token, root)).event);
    if (current.event_id !== id || !current.start_time || !current.end_time) throw new AppError("resource_precheck_failed", "未能核对日程身份及起止时间，未执行删除。", 502);
    if (await eventHash(current) !== a.expected_event_hash) throw new AppError("revision_conflict", "日程已变化，请重新读取详情并核对后删除。", 409);
    const repeating = typeof current.recurrence === "string" && current.recurrence.length > 0;
    const series = repeating && id.endsWith("_0");
    if ((a.delete_scope === "series" && !series) || (a.delete_scope === "single" && series) || (repeating && !/_\d+$/.test(id))) throw new AppError("invalid_input", "删除范围与日程不符。删除整个重复系列须明确选择 series 并使用系列 ID；仅删一次须先取得该次实例 ID。未执行删除。");
    const result = { calendar_id: calendar, event_id: id, summary: current.summary ?? "", start_time: current.start_time, end_time: current.end_time, delete_scope: a.delete_scope };
    if (current.status === "cancelled") return { ...result, deleted: true, state: "already_cancelled" };
    await callApi(token, queryPath(root, { need_notification: a.need_notification === true }), undefined, "DELETE");
    return { ...result, deleted: true, state: "deleted", need_notification: a.need_notification === true };
  }, true, true),
  integration("feishu_get_bitable_record", "核对单条多维表格记录", "读取一条记录的完整可见字段及 record_hash，删除该记录前先核对。", recordFields, ["app", "table_id", "record_id"], ["bitable:app:readonly"], async (_e, _u, a, token) => readRecord(token, a)),
  integration("feishu_delete_bitable_record", "删除多维表格记录", "仅删除用户明确指定的一条记录。先用 feishu_get_bitable_record 读取并核对 record_hash；不会删除整张数据表。批量创建产生的记录也逐条核对删除。", { ...recordFields, expected_record_hash: hashField("单条记录工具返回的 record_hash") }, ["app", "table_id", "record_id", "expected_record_hash"], ["bitable:app"], async (_e, _u, a, token) => {
    const { root } = tableRoot(a), current = await readRecord(token, a);
    if (current.record_hash !== a.expected_record_hash) throw new AppError("revision_conflict", "记录内容已变化，请重新读取并核对后删除。", 409);
    const id = String(current.record.record_id);
    const result = await callApi(token, `${root}/records/${id}?ignore_consistency_check=false`, undefined, "DELETE");
    if (result.record_id !== id || result.deleted !== true) throw new AppError("delete_not_confirmed", "飞书未确认指定记录已删除，请先核对状态。", 502);
    return { app_token: resourceToken(a.app, ["base", "bitable"]), table_id: a.table_id, record_id: id, deleted: true, state: "deleted" };
  }, true, true),
  integration("feishu_delete_bitable_table", "删除多维表格数据表", "删除用户明确指定的数据表及其中全部记录，保留整个多维表格应用。先通过数据表列表核对 table_id、准确名称和 revision；如果只需删除记录，应使用记录删除工具。", { ...bitableFields, expected_name: stringField("数据表列表中的准确名称", 100), expected_revision: { type: "integer", minimum: 0, description: "数据表列表返回的 revision；记录或表名变化都会改变版本" } }, ["app", "table_id", "expected_name", "expected_revision"], ["bitable:app"], async (_e, _u, a, token) => {
    const current = await readTable(token, a);
    if (current.name !== a.expected_name || current.revision !== a.expected_revision) throw new AppError("revision_conflict", "数据表名称或版本已变化，请重新读取列表并核对后删除。", 409);
    const { app, table, root } = tableRoot(a);
    await callApi(token, root, undefined, "DELETE");
    return { app_token: app, table_id: table, name: current.name, deleted: true, state: "deleted", includes_all_records: true };
  }, true, true),
  integration("feishu_delete_document", "删除整份飞书文档", "按用户明确要求，将指定云空间新版文档移入回收站。先读取文档结构，核对标题与 revision_id。仅支持 docx 链接或 ID，不自动删除知识库节点、文件夹或其他类型文件。", {
    document: stringField("云空间 /docx/ 链接或新版文档 ID；不接受 /wiki/ 链接"),
    expected_title: { ...stringField("读取文档返回的准确标题", 1000), minLength: 0 },
    expected_revision_id: { type: "integer", minimum: 0, maximum: 1000000000, description: "读取文档结构返回的 revision_id" },
  }, ["document", "expected_title", "expected_revision_id"], ["docx:document:readonly", "space:document:delete"], async (_e, _u, a, token) => {
    const id = documentId(resourceToken(a.document, ["docx"]));
    const current = obj((await callApi(token, `/docx/v1/documents/${id}`)).document);
    if (current.document_id !== id || typeof current.title !== "string" || !Number.isInteger(current.revision_id)) throw new AppError("resource_precheck_failed", "无法核对文档身份、标题和版本，未执行删除。", 502);
    if (current.title !== a.expected_title || current.revision_id !== a.expected_revision_id) throw new AppError("revision_conflict", "文档标题或内容已变化，请重新读取并核对要删除的文档。", 409);
    const result = await callApi(token, queryPath(`/drive/v1/files/${id}`, { type: "docx", async: false }), undefined, "DELETE");
    // Document deletion is normally synchronous. Never report an unexpected
    // asynchronous acceptance as completed, and never retry a pending delete.
    if (result.task_id) return { document_id: id, title: current.title, deleted: false, state: "pending", task_id: result.task_id, next_tool: "feishu_get_delete_task", next_arguments: { scenario: "drive", task_id: result.task_id }, note: "飞书已受理异步删除；继续查询任务，不要重复提交。" };
    return { document_id: id, title: current.title, deleted: true, state: "deleted", destination: "recycle_bin" };
  }, true, true),
];
