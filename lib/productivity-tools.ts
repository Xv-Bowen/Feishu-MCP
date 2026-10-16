import { AppError, documentChunk } from "./core";
import { apiResponse, providerError } from "./feishu";
import { calendarTime, eventHash } from "./calendars";
import { readLimited } from "./resources";
import { sha256 } from "./crypto";
import { identifier, pageResult, pagination, pagingFields, resourceToken, stringField, type Arguments } from "./workspace-common";
import { boolField, callApi, enumField, integration, objectArray, obj, queryPath } from "./integration-common";

const openId = { ...stringField("已核实的用户 open_id", 100), pattern: "^ou_[A-Za-z0-9_-]{4,100}$" };
const date = stringField("带时区的 ISO 8601 时间，或全天日期 YYYY-MM-DD", 50), guid = stringField("任务或清单 GUID", 100);
const calendar = stringField("日历 ID", 200), event = stringField("日程 ID", 200), hash = stringField("读取详情返回的校验值", 100);
const taskChanges = { summary: stringField("任务标题", 3000), description: { ...stringField("任务描述", 3000), minLength: 0 }, due: date, start: date };
const members = objectArray({ id: openId, role: enumField(["assignee", "follower"]) }, ["id", "role"], 50);
const taskRoot = (a: Arguments) => `/task/v2/tasks/${encodeURIComponent(identifier(a.task_guid))}`;
const eventRoot = (a: Arguments) => `/calendar/v4/calendars/${encodeURIComponent(identifier(a.calendar_id, "日历 ID", /^[A-Za-z0-9_.@+-]{8,200}$/))}/events/${encodeURIComponent(identifier(a.event_id, "日程 ID", /^[A-Za-z0-9_.@+-]{8,200}$/))}`;
const taskTime = (value: unknown) => { const parsed = calendarTime(value); return { timestamp: String(parsed.milliseconds), is_all_day: parsed.allDay }; };
function taskBody(a: Arguments) {
  const body: Arguments = {};
  for (const key of ["summary", "description"]) if (a[key] !== undefined) body[key] = a[key];
  for (const key of ["start", "due"]) if (a[key] !== undefined) body[key] = taskTime(a[key]);
  if (body.start && body.due && (Number(obj(body.start).timestamp) > Number(obj(body.due).timestamp) || obj(body.start).is_all_day !== obj(body.due).is_all_day)) throw new AppError("invalid_input", "任务开始时间不能晚于截止时间，且两者须同为全天或具体时间。");
  return body;
}
export async function taskHash(task: Arguments) { return sha256(JSON.stringify({ guid: task.guid, summary: task.summary, description: task.description, start: task.start, due: task.due, completed_at: task.completed_at, updated_at: task.updated_at, members: task.members })); }
async function checkedTask(token: string, a: Arguments) {
  const data = await callApi(token, taskRoot(a) + "?user_id_type=open_id"), task = obj(data.task);
  if (!task.guid) throw new AppError("invalid_response", "飞书未返回任务详情。", 502);
  if (await taskHash(task) !== a.expected_task_hash) throw new AppError("revision_conflict", "任务已变化，请重新读取详情再修改。", 409);
  return task;
}
export const PRODUCTIVITY_INTEGRATIONS = [
  integration("feishu_query_freebusy", "查询日程忙闲", "查询一个已核实用户或会议室的忙闲；范围最多 90 天，结果仅限当前账号可访问的忙闲信息。", { user_id: openId, room_id: stringField("会议室 room_id", 100), start_time: date, end_time: date }, ["start_time", "end_time"], ["calendar:calendar:readonly"], async (_e, _u, a, token) => {
    if (!!a.user_id === !!a.room_id) throw new AppError("invalid_input", "user_id 与 room_id 须且只能提供一个。");
    const start = calendarTime(a.start_time), end = calendarTime(a.end_time);
    if (start.allDay || end.allDay || end.milliseconds <= start.milliseconds || end.milliseconds - start.milliseconds > 90 * 86400000) throw new AppError("invalid_input", "忙闲查询须使用带时区的开始和结束时间，且区间为 0 至 90 天。");
    return callApi(token, "/calendar/v4/freebusy/list?user_id_type=open_id", { time_min: a.start_time, time_max: a.end_time, ...(a.user_id ? { user_id: a.user_id } : { room_id: a.room_id }), only_busy: true, include_external_calendar: true });
  }),
  integration("feishu_list_calendar_attendees", "查看日程参会人", "读取指定日程的一页参会人及回复状态。", { calendar_id: calendar, event_id: event, ...pagingFields, limit: { type: "integer", minimum: 10, maximum: 100, default: 20 } }, ["calendar_id", "event_id"], ["calendar:calendar:readonly"], async (_e, _u, a, token) => {
    const p = pagination({ ...a, limit: a.limit ?? 20 }); p.set("user_id_type", "open_id");
    return pageResult(await callApi(token, `${eventRoot(a)}/attendees?${p}`));
  }),
  integration("feishu_add_calendar_attendees", "添加日程参会人", "按明确请求邀请已核实的用户参加日程。先读取日程和参会人；默认不发日历通知，need_notification=true 才由飞书发送日历通知。邀请仍受组织及日历权限限制。", { calendar_id: calendar, event_id: event, expected_event_hash: hash, attendees: objectArray({ user_id: openId, is_optional: boolField }, ["user_id"], 100), need_notification: boolField }, ["calendar_id", "event_id", "expected_event_hash", "attendees"], ["calendar:calendar"], async (_e, _u, a, token) => {
    const data = await callApi(token, eventRoot(a)), current = obj(data.event);
    if (!data.event || await eventHash(current) !== a.expected_event_hash) throw new AppError("revision_conflict", "日程已变化，请重新核对后邀请。", 409);
    const ids = (a.attendees as Arguments[]).map(item => item.user_id); if (new Set(ids).size !== ids.length) throw new AppError("invalid_input", "参会人列表有重复。");
    return callApi(token, `${eventRoot(a)}/attendees?user_id_type=open_id`, { attendees: (a.attendees as Arguments[]).map(item => ({ type: "user", ...item })), need_notification: a.need_notification === true });
  }, true),
  integration("feishu_list_tasks", "查看我负责的任务", "分页读取当前用户负责的任务，可按完成状态筛选。此接口不是全部可访问任务的总列表。", { completed: boolField, ...pagingFields }, [], ["task:task:read"], async (_e, _u, a, token) => {
    const p = pagination(a); p.set("user_id_type", "open_id"); p.set("type", "my_tasks"); if (a.completed !== undefined) p.set("completed", String(a.completed));
    return pageResult(await callApi(token, `/task/v2/tasks?${p}`));
  }),
  integration("feishu_get_task", "读取任务详情", "读取任务及 task_hash；修改任务前先确认最新内容。", { task_guid: guid }, ["task_guid"], ["task:task:read"], async (_e, _u, a, token) => {
    const data = await callApi(token, taskRoot(a) + "?user_id_type=open_id"); if (!obj(data.task).guid) throw new AppError("invalid_response", "未返回任务详情。", 502);
    return { ...data, task_hash: await taskHash(obj(data.task)) };
  }),
  integration("feishu_create_task", "创建飞书任务", "创建任务，可指定起止时间和负责人/关注人。不传 members 时默认把当前账号设为负责人；assign_to_me=false 可创建无负责人任务。只按用户明确要求分派任务。", { ...taskChanges, members, assign_to_me: boolField, tasklist_guid: guid }, ["summary"], ["task:task:write"], async (e, u, a, token) => {
    const body = taskBody(a);
    if (a.members) body.members = (a.members as Arguments[]).map(item => ({ ...item, type: "user" }));
    else if (a.assign_to_me !== false) {
      const me = await e.DB!.prepare("SELECT open_id FROM feishu_connections WHERE user_id = ?").bind(u).first<{ open_id: string }>();
      if (!me?.open_id) throw new AppError("connection_changed", "当前用户连接已变化。", 409);
      body.members = [{ id: me.open_id, type: "user", role: "assignee" }];
    }
    if (a.tasklist_guid) body.tasklists = [{ tasklist_guid: identifier(a.tasklist_guid) }];
    return callApi(token, "/task/v2/tasks?user_id_type=open_id", body);
  }, true),
  integration("feishu_update_task", "修改或完成飞书任务", "修改明确提供的字段。completed=true 表示整体完成，false 恢复未完成；不代表会签任务中的个人完成。先读取 task_hash；成员变更用单独工具。", { task_guid: guid, expected_task_hash: hash, ...taskChanges, completed: boolField }, ["task_guid", "expected_task_hash"], ["task:task:write"], async (_e, _u, a, token) => {
    const current = await checkedTask(token, a), body = taskBody(a);
    if (a.completed !== undefined && a.completed !== (!!current.completed_at && current.completed_at !== "0")) body.completed_at = a.completed ? String(Date.now()) : "0";
    if (!Object.keys(body).length) { if (a.completed !== undefined) return { task: current, unchanged: true }; throw new AppError("invalid_input", "请明确需要修改的任务字段。"); }
    const combined = { ...current, ...body }, start = obj(combined.start), due = obj(combined.due);
    if (start.timestamp && due.timestamp && (Number(start.timestamp) > Number(due.timestamp) || start.is_all_day !== due.is_all_day)) throw new AppError("invalid_input", "修改后的开始与截止时间不一致。");
    return callApi(token, taskRoot(a) + "?user_id_type=open_id", { task: body, update_fields: Object.keys(body) }, "PATCH");
  }, true, true),
  integration("feishu_change_task_members", "调整任务负责人和关注人", "按明确请求添加或移除已核实的负责人/关注人；先读取详情及 task_hash。", { task_guid: guid, expected_task_hash: hash, operation: enumField(["add", "remove"]), members }, ["task_guid", "expected_task_hash", "operation", "members"], ["task:task:write"], async (_e, _u, a, token) => {
    await checkedTask(token, a);
    return callApi(token, `${taskRoot(a)}/${a.operation === "add" ? "add_members" : "remove_members"}?user_id_type=open_id`, { members: (a.members as Arguments[]).map(item => ({ ...item, type: "user" })) });
  }, true, true),
  integration("feishu_delete_task", "删除飞书任务", "按用户明确要求删除指定任务；先读取详情，核对 task_guid、标题与 task_hash。删除后无法再读取该任务；此操作不是标记完成。", { task_guid: guid, expected_task_hash: hash }, ["task_guid", "expected_task_hash"], ["task:task:write"], async (_e, _u, a, token) => {
    const current = await checkedTask(token, a);
    if (current.guid !== a.task_guid) throw new AppError("resource_precheck_failed", "任务身份不匹配，未执行删除。", 502);
    await callApi(token, taskRoot(a), undefined, "DELETE");
    return { task_guid: current.guid, summary: current.summary, deleted: true };
  }, true, true),
  integration("feishu_list_tasklists", "查看任务清单", "分页列出可访问的任务清单。", { ...pagingFields }, [], ["task:tasklist:read"], async (_e, _u, a, token) => pageResult(await callApi(token, `/task/v2/tasklists?${pagination(a)}&user_id_type=open_id`))),
  integration("feishu_create_tasklist", "创建任务清单", "创建以当前账号为所有者的任务清单，不自动添加其他成员。", { name: stringField("清单名称", 100) }, ["name"], ["task:tasklist:write"], async (_e, _u, a, token) => callApi(token, "/task/v2/tasklists?user_id_type=open_id", { name: a.name }), true),
  integration("feishu_delete_tasklist", "删除任务清单", "按用户明确要求删除指定任务清单，清单删除后不可恢复。先读取清单列表和清单内任务，核对 GUID 与名称。本工具只提交清单删除请求，不逐条执行任务删除。", { tasklist_guid: guid, expected_name: stringField("从清单列表核对的准确名称", 100) }, ["tasklist_guid", "expected_name"], ["task:tasklist:write"], async (_e, _u, a, token) => {
    const id = identifier(a.tasklist_guid), path = `/task/v2/tasklists/${id}`;
    const current = obj((await callApi(token, path + "?user_id_type=open_id")).tasklist);
    if (current.guid !== id || typeof current.name !== "string") throw new AppError("resource_precheck_failed", "无法核对任务清单身份和名称，未执行删除。", 502);
    if (current.name !== a.expected_name) throw new AppError("revision_conflict", "任务清单名称已变化，请重新读取并核对要删除的清单。", 409);
    await callApi(token, path, undefined, "DELETE");
    return { tasklist_guid: id, name: current.name, deleted: true, individual_task_deletes_performed: false };
  }, true, true),
  integration("feishu_list_tasklist_tasks", "读取清单内任务", "分页读取指定清单中的任务；空页但 has_more=true 时仍须续读。", { tasklist_guid: guid, completed: boolField, ...pagingFields }, ["tasklist_guid"], ["task:tasklist:read"], async (_e, _u, a, token) => {
    const p = pagination(a); p.set("user_id_type", "open_id"); if (a.completed !== undefined) p.set("completed", String(a.completed));
    return pageResult(await callApi(token, `/task/v2/tasklists/${identifier(a.tasklist_guid)}/tasks?${p}`));
  }),
  integration("feishu_read_minutes", "读取妙记文字记录", "导出当前账号有权访问的妙记转写文字，保留说话人与时间戳；长文按 next_offset 继续。最多读取 8 MiB 转写文件，不下载音视频。", { minutes: stringField("/minutes/ 链接或 minute_token"), format: enumField(["txt", "srt"]), offset: { type: "integer", minimum: 0 }, max_characters: { type: "integer", minimum: 1000, maximum: 40000 } }, ["minutes"], ["minutes:minutes.transcript:export"], async (_e, _u, a, token) => {
    const id = resourceToken(a.minutes, ["minutes"]), path = queryPath(`/minutes/v1/minutes/${id}/transcript`, { file_format: String(a.format || "txt"), need_speaker: true, need_timestamp: true });
    const response = await apiResponse(token, path);
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AppError("provider_redirect", "妙记接口发生跳转，已停止读取。", 502); }
    if (!response.ok || (response.headers.get("content-type") || "").includes("application/json")) { let payload = {}; try { payload = await response.json(); } catch {} providerError(response, payload, path, [token]); }
    const content = new TextDecoder().decode(await readLimited(response, 8 * 1024 * 1024));
    return { minute_token: id, ...documentChunk(content, a), format: a.format || "txt" };
  }),
];
