import { AppError } from "./core";
import { accessToken, apiWithToken, type Runtime } from "./feishu";
import { identifier, pagingFields, pagination, pageResult, resourceToken, stringField, text, tool, writeOnce, type Arguments } from "./workspace-common";

const spreadsheet = stringField("/sheets/ 链接或 spreadsheet_token");
const app = stringField("/base/ 链接或 app_token；知识库链接先用解析工具取得 token");
const tableId = stringField("数据表 tbl_ 或 tbl 开头的 table_id",100);
const range = stringField("工作表 ID 和完整 A1 范围，例如 abc123!A1:D20",100);
const baseProps = { app, table_id: tableId };
export const TABLE_TOOLS = [
  tool("feishu_list_sheets","查看电子表格工作表","列出电子表格中的工作表 ID、名称和行列信息。",{spreadsheet},["spreadsheet"]),
  tool("feishu_read_sheet","读取电子表格","读取一个明确的单元格范围，每次最多 10000 格。",{spreadsheet,range},["spreadsheet","range"]),
  tool("feishu_write_sheet","写入电子表格","写入指定单元格范围，可能覆盖原值。先读取并确认目标范围，只写用户明确要求的内容。",{spreadsheet,range,values:{type:"array",minItems:1,maxItems:1000,items:{type:"array",minItems:1,maxItems:100,items:{type:["string","number","boolean","null"]}}}},["spreadsheet","range","values"],true,true),
  tool("feishu_create_spreadsheet","创建电子表格","创建新的电子表格，可指定文件夹。",{title:stringField("表格标题",200),folder_token:stringField("文件夹 token",100)},["title"],true),
  tool("feishu_list_bitable_tables","查看多维表格数据表","读取多维表格内一页数据表列表。",{app,...pagingFields},["app"]),
  tool("feishu_list_bitable_fields","查看多维表格字段","读取字段名称、类型和选项，写入前先确认字段结构。",{...baseProps,...pagingFields},["app","table_id"]),
  tool("feishu_read_bitable_records","读取多维表格记录","读取一页可访问的记录，可指定视图；不会自动读取全部页面。",{...baseProps,view_id:stringField("视图 ID",100),...pagingFields},["app","table_id"]),
  tool("feishu_create_bitable_record","新增多维表格记录","按字段名称写入一条新记录。字段类型和数据格式以字段读取工具为准。",{...baseProps,fields:{type:"object",description:"字段名称到值的映射；支持文字、数字、选项、日期等官方字段格式。",additionalProperties:true}},["app","table_id","fields"],true),
  tool("feishu_update_bitable_record","修改多维表格记录","修改指定 record_id 的字段，覆盖所提供字段的旧值；未提供的字段不变。",{...baseProps,record_id:stringField("rec 开头的记录 ID",100),fields:{type:"object",additionalProperties:true}},["app","table_id","record_id","fields"],true,true),
];

export function sheetRange(input:unknown) {
  const value = text(input,"单元格范围",100);
  const m=/^([A-Za-z0-9_-]{1,60})!([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/.exec(value);
  if(!m) throw new AppError("invalid_input","请使用工作表 ID!A1:D20 格式的完整范围。");
  const col=(v:string)=>[...v].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
  const rows=Number(m[5]||m[3])-Number(m[3])+1,columns=col(m[4]||m[2])-col(m[2])+1;
  if(rows<1||columns<1||rows>1000||columns>100||rows*columns>10000) throw new AppError("invalid_input","范围顺序无效或超过每次 1000 行、100 列、10000 格的上限。");
  return {value,rows,columns};
}
function values(input:unknown,r:ReturnType<typeof sheetRange>) {
  if(!Array.isArray(input)||!input.length||input.length>r.rows) throw new AppError("invalid_input","数据行数须符合目标范围。");
  let count=0;
  for(const row of input) {
    if(!Array.isArray(row)||!row.length||row.length>r.columns) throw new AppError("invalid_input","数据列数须符合目标范围。");
    count+=row.length;
    for(const value of row) if(value!==null && !["string","number","boolean"].includes(typeof value) || typeof value==="number"&&!Number.isFinite(value) || typeof value==="string"&&value.length>20000) throw new AppError("invalid_input","单元格只支持文字、有限数值、布尔值或 null。");
  }
  if(count>10000||JSON.stringify(input).length>50000) throw new AppError("invalid_input","本次写入数据过多，请分批写入。");
  return input;
}
function fields(input:unknown) {
  if(!input||typeof input!=="object"||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).length>100||JSON.stringify(input).length>40000) throw new AppError("invalid_input","请提供不超过 100 个字段的字段名称到值映射。");
  return input;
}

export async function runTableTool(env:Runtime,user:string,name:string,args:Arguments):Promise<unknown> {
  if(name==="feishu_create_spreadsheet") {
    const title=text(args.title,"标题",200),folder=args.folder_token===undefined?null:identifier(args.folder_token);
    return writeOnce(env,user,name,args,["sheets:spreadsheet"],async token=>await apiWithToken(token,"/sheets/v3/spreadsheets",{title,...(folder?{folder_token:folder}:{})}));
  }
  if(name.includes("bitable")) {
    const base=resourceToken(args.app,["base","bitable"]);
    const t=name==="feishu_list_bitable_tables"?null:identifier(args.table_id,"数据表 ID",/^tbl[A-Za-z0-9_-]{3,100}$/);
    const root=`/bitable/v1/apps/${base}/tables${t?`/${t}`:""}`;
    if(name==="feishu_create_bitable_record"||name==="feishu_update_bitable_record") {
      const body={fields:fields(args.fields)},record=name==="feishu_update_bitable_record"?identifier(args.record_id,"记录 ID",/^rec[A-Za-z0-9_-]{3,100}$/):null;
      return writeOnce(env,user,name,args,["bitable:app"],async token=>await apiWithToken(token,`${root}/records${record?`/${record}`:""}`,body,record?"PUT":"POST"));
    }
    const params=pagination(args);
    if(name==="feishu_read_bitable_records"&&args.view_id!==undefined) params.set("view_id",identifier(args.view_id,"视图 ID",/^vew[A-Za-z0-9_-]{3,100}$/));
    const path=name==="feishu_list_bitable_tables"?root:name==="feishu_list_bitable_fields"?`${root}/fields`:`${root}/records`;
    const data=await apiWithToken(await accessToken(env,user,["bitable:app:readonly"]),`${path}?${params}`) as Arguments;
    return pageResult(data);
  }
  const id=resourceToken(args.spreadsheet,["sheets"]);
  if(name==="feishu_list_sheets") return await apiWithToken(await accessToken(env,user,["sheets:spreadsheet:readonly"]),`/sheets/v3/spreadsheets/${id}/sheets/query`);
  const r=sheetRange(args.range);
  if(name==="feishu_read_sheet") return await apiWithToken(await accessToken(env,user,["sheets:spreadsheet:readonly"]),`/sheets/v2/spreadsheets/${id}/values_batch_get?${new URLSearchParams({ranges:r.value,valueRenderOption:"ToString",dateTimeRenderOption:"FormattedString"})}`);
  if(name==="feishu_write_sheet") {
    const matrix=values(args.values,r);
    return writeOnce(env,user,name,args,["sheets:spreadsheet"],async token=>await apiWithToken(token,`/sheets/v2/spreadsheets/${id}/values`,{valueRange:{range:r.value,values:matrix}},"PUT"));
  }
  throw new AppError("unknown_tool","未知表格工具。");
}
