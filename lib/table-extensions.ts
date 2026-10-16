import { AppError } from "./core";
import { sheetRange } from "./tables";
import { identifier, pageResult, pagination, pagingFields, resourceToken, stringField, type Arguments } from "./workspace-common";
import { boolField, callApi, enumField, integration, jsonObject, objectArray, obj, queryPath } from "./integration-common";

const spreadsheet = stringField("电子表格 /sheets/ 链接或 token"), sheet = stringField("工作表 sheet_id", 60);
const sheetsRoot = (a: Arguments) => `/sheets/v2/spreadsheets/${resourceToken(a.spreadsheet, ["sheets"])}`;
const app = stringField("多维表格 /base/ 链接或 app_token"), table = stringField("数据表 table_id", 100);
const tableRoot = (a: Arguments) => `/bitable/v1/apps/${resourceToken(a.app, ["base", "bitable"])}/tables`;
const fieldDefinition = { field_name: stringField("字段名称", 100), type: { type: "integer", enum: [1,2,3,4,5,7,11,13,15,17,18,19,20,21,22,23,1001,1002,1003,1004,1005] }, property: jsonObject };
const condition = { field_name: stringField("字段名称", 100), operator: enumField(["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual", "like", "in"]), value: { type: "array", maxItems: 100, items: { type: "string", maxLength: 2000 } } };
const filter = { type: "object", additionalProperties: false, required: ["conjunction", "conditions"], properties: { conjunction: enumField(["and", "or"]), conditions: objectArray(condition, ["field_name", "operator"], 50), children: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["conjunction", "conditions"], properties: { conjunction: enumField(["and", "or"]), conditions: objectArray(condition, ["field_name", "operator"], 50) } } } } };
const color = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$", description: "#RRGGBB 颜色" };
export const TABLE_INTEGRATIONS = [
  integration("feishu_add_sheet", "新增工作表", "在现有电子表格新增一个工作表。", { spreadsheet, title: stringField("工作表名称", 100), index: { type: "integer", minimum: 0, maximum: 299 } }, ["spreadsheet", "title"], ["sheets:spreadsheet"], async (_e, _u, a, token) => callApi(token, `${sheetsRoot(a)}/sheets_batch_update`, { requests: [{ addSheet: { properties: { title: a.title, ...(a.index === undefined ? {} : { index: a.index }) } } }] }), true),
  integration("feishu_copy_sheet", "复制工作表", "在同一电子表格内复制指定工作表。", { spreadsheet, sheet_id: sheet, title: stringField("副本名称", 100) }, ["spreadsheet", "sheet_id", "title"], ["sheets:spreadsheet"], async (_e, _u, a, token) => callApi(token, `${sheetsRoot(a)}/sheets_batch_update`, { requests: [{ copySheet: { source: { sheetId: identifier(a.sheet_id, "工作表 ID", /^[A-Za-z0-9_-]{1,60}$/) }, destination: { title: a.title } } }] }), true),
  integration("feishu_delete_sheet", "删除工作表", "删除一个工作表及其中数据。必须先读取工作表列表并明确核对 ID 与名称；仅在用户明确要求删除时调用。", { spreadsheet, sheet_id: sheet, expected_title: stringField("从工作表列表核对的名称", 100) }, ["spreadsheet", "sheet_id", "expected_title"], ["sheets:spreadsheet"], async (_e, _u, a, token) => {
    const id = resourceToken(a.spreadsheet, ["sheets"]), sid = identifier(a.sheet_id, "工作表 ID", /^[A-Za-z0-9_-]{1,60}$/);
    const data = await callApi(token, `/sheets/v3/spreadsheets/${id}/sheets/query`), items = Array.isArray(data.sheets) ? data.sheets.map(obj) : [];
    if (!items.some(item => item.sheet_id === sid && item.title === a.expected_title)) throw new AppError("revision_conflict", "工作表不存在或名称已变化，请重新核对后删除。", 409);
    if (items.length < 2) throw new AppError("invalid_input", "不能删除最后一个工作表。");
    return callApi(token, `${sheetsRoot(a)}/sheets_batch_update`, { requests: [{ deleteSheet: { sheetId: sid } }] });
  }, true, true),
  integration("feishu_format_sheet", "设置单元格样式", "对明确范围批量设置加粗、斜体、字体大小、颜色、对齐或数字格式；不改变单元格值。", { spreadsheet, ranges: { type: "array", minItems: 1, maxItems: 20, items: stringField("工作表ID!A1:D20", 100) }, style: { type: "object", minProperties: 1, additionalProperties: false, properties: { font: { type: "object", additionalProperties: false, properties: { bold: boolField, italic: boolField, fontSize: { type: "string", pattern: "^(?:9|[12][0-9]|3[0-6])pt/1\\.5$" } } }, backColor: color, foreColor: color, hAlign: { type: "integer", enum: [0,1,2] }, vAlign: { type: "integer", enum: [0,1,2] }, formatter: stringField("数字格式，例如 0.00 或 yyyy/MM/dd", 100) } } }, ["spreadsheet", "ranges", "style"], ["sheets:spreadsheet"], async (_e, _u, a, token) => {
    const ranges = (a.ranges as unknown[]).map(r => sheetRange(r).value); if (!Object.keys(obj(a.style)).length) throw new AppError("invalid_input", "请至少提供一种样式。");
    return callApi(token, `${sheetsRoot(a)}/styles_batch_update`, { data: [{ ranges, style: a.style }] }, "PUT");
  }, true, true),
  integration("feishu_search_bitable_records", "按条件查询多维表格", "由飞书筛选并排序记录，按页返回。指定 filter 或 sort 时，飞书会忽略视图筛选。", { app, table_id: table, view_id: stringField("视图 ID", 100), field_names: { type: "array", minItems: 1, maxItems: 100, items: stringField("字段名", 100) }, filter, sort: objectArray({ field_name: stringField("字段名", 100), desc: boolField }, ["field_name"], 20), automatic_fields: boolField, ...pagingFields }, ["app", "table_id"], ["bitable:app:readonly"], async (_e, _u, a, token) => {
    const body: Arguments = {}; for (const key of ["view_id", "field_names", "filter", "sort", "automatic_fields"]) if (a[key] !== undefined) body[key] = a[key];
    const p = pagination(a); p.set("user_id_type", "open_id");
    return { ...pageResult(await callApi(token, `${tableRoot(a)}/${identifier(a.table_id, "数据表 ID", /^tbl[A-Za-z0-9_-]{3,100}$/)}/records/search?${p}`, body)), ...(a.view_id && (a.filter || a.sort) ? { notice: "已指定 filter/sort，飞书不会使用 view_id 中的筛选条件。" } : {}) };
  }),
  integration("feishu_batch_create_bitable_records", "批量新增多维表格记录", "一次新增至多 100 条记录；字段类型先用字段工具核对。使用 request_id 防止重试重复创建。", { app, table_id: table, records: objectArray({ fields: jsonObject }, ["fields"], 100) }, ["app", "table_id", "records"], ["bitable:app"], async (_e, _u, a, token) => {
    if ((a.records as Arguments[]).some(item => !Object.keys(obj(item.fields)).length) || JSON.stringify(a.records).length > 50000) throw new AppError("invalid_input", "记录字段不能为空，且本次数据不能超过 50000 字符。");
    return callApi(token, queryPath(`${tableRoot(a)}/${identifier(a.table_id, "数据表 ID", /^tbl[A-Za-z0-9_-]{3,100}$/)}/records/batch_create`, { user_id_type: "open_id" }), { records: a.records });
  }, true),
  integration("feishu_create_bitable_table", "创建多维表格数据表", "在现有多维表格中新建数据表，可指定字段和默认视图名称。不会新建整个多维表格应用。", { app, name: stringField("数据表名称", 100), default_view_name: stringField("默认视图名称；须同时指定字段", 100), fields: objectArray(fieldDefinition, ["field_name", "type"], 100) }, ["app", "name"], ["bitable:app"], async (_e, _u, a, token) => {
    if (a.default_view_name && !a.fields) throw new AppError("invalid_input", "设置默认视图名称时必须指定字段。");
    if (a.fields && ![1,2,5,13,15,20,22].includes(Number((a.fields as Arguments[])[0].type))) throw new AppError("invalid_input", "首个索引字段类型不受支持。");
    return callApi(token, tableRoot(a), { table: { name: a.name, ...(a.default_view_name ? { default_view_name: a.default_view_name } : {}), ...(a.fields ? { fields: a.fields } : {}) } });
  }, true),
];
