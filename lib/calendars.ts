import { AppError } from "./core";
import { accessToken, apiWithToken, type Runtime } from "./feishu";
import { sha256 } from "./crypto";
import { identifier, pagingFields, pagination, pageResult, stringField, text, tool, writeOnce, type Arguments } from "./workspace-common";

const calendar=stringField("从日历列表返回的 calendar_id",200),event=stringField("event_id",200);
const date=stringField("带时区的 ISO 8601 时间，或全天日期 YYYY-MM-DD",50);
const calendarPagingFields={...pagingFields,limit:{...pagingFields.limit,minimum:50,description:"每页 50–100 条。旧客户端传入小于 50 的值时按 50 查询，不丢弃该页其余记录。"}};
function calendarPagination(args:Arguments) {
  const params=pagination(args);
  // The provider rejects page_size < 50. Keep cached clients that still send
  // small limits usable, and expose the actual page size without slicing away
  // records that the provider's next-page cursor would otherwise skip.
  params.set("page_size",String(Math.max(50,Number(params.get("page_size")))));
  return params;
}
const change={summary:stringField("日程标题",300),description:{...stringField("日程描述",5000),minLength:0},start_time:date,end_time:date,timezone:{type:"string",default:"Asia/Taipei",description:"IANA 时区名称"},location:{...stringField("地点",500),minLength:0},recurrence:stringField("可选 RFC5545 重复规则，例如 FREQ=WEEKLY;INTERVAL=1;BYDAY=MO；不传保持原规则，不能用空串取消重复。",1000)};
export const CALENDAR_TOOLS=[
  tool("feishu_list_calendars","查看日历","读取当前账号可访问的一页日历及访问角色，每页至少 50 条。",calendarPagingFields,[]),
  tool("feishu_list_calendar_events","查看日历日程","按带时区的明确开始和结束时间查询日历的一页日程，每页至少 50 条，不自动展开全部历史。",{calendar_id:calendar,start_time:stringField("带时区的 ISO 8601 开始时间",50),end_time:stringField("带时区的 ISO 8601 结束时间",50),...calendarPagingFields},["calendar_id","start_time","end_time"]),
  tool("feishu_get_calendar_event","读取日程详情","读取日程详情及内容校验值，修改前先核对最新内容。",{calendar_id:calendar,event_id:event},["calendar_id","event_id"]),
  tool("feishu_create_calendar_event","创建日程","在可编辑的日历中创建普通、全天或重复日程；参会人通过单独工具添加。",{calendar_id:calendar,...change},["calendar_id","summary","start_time","end_time"],true),
  tool("feishu_update_calendar_event","修改日程","只修改明确提供的字段。先读取详情并传入 expected_event_hash；重复规则修改须明确针对整个系列还是实例，系列通常是 _0 后缀。",{calendar_id:calendar,event_id:event,expected_event_hash:stringField("详情工具返回的 event_hash",100),...change},["calendar_id","event_id","expected_event_hash"],true,true),
];
export function calendarTime(input:unknown,timezone="Asia/Taipei") {
  const value=text(input,"日期时间",50);
  try { new Intl.DateTimeFormat("en-US",{timeZone:timezone}); } catch { throw new AppError("invalid_input","时区名称无效。"); }
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms=Date.parse(value+"T00:00:00Z");
    if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==value) throw new AppError("invalid_input","日期无效。");
    return {body:{date:value},milliseconds:ms,allDay:true};
  }
  const localDate = value.slice(0,10), day = Date.parse(localDate+"T00:00:00Z");
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value))||!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==localDate||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59) throw new AppError("invalid_input","日程时间须为有效日期并包含时区，例如 2026-10-14T09:00:00+08:00。");
  return {body:{timestamp:String(Math.floor(Date.parse(value)/1000)),timezone},milliseconds:Date.parse(value),allDay:false};
}
function eventId(input:unknown,label:string) { return identifier(input,label,/^[A-Za-z0-9_.@+-]{8,200}$/); }
function comparable(event:Arguments) { return {summary:event.summary||"",description:event.description||"",start_time:event.start_time,end_time:event.end_time,location:event.location||null,recurrence:event.recurrence||null,status:event.status||null}; }
export async function eventHash(event:Arguments) { return sha256(JSON.stringify(comparable(event))); }
export function recurrenceRule(input:unknown) {
  const value=text(input,"重复规则",1000).replace(/^RRULE:/,"");
  if(!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(value)) throw new AppError("invalid_input","重复规则须为支持的 RFC5545 RRULE，例如 FREQ=WEEKLY;BYDAY=MO。");
  const fields=value.split(";").map(part=>part.split("="));
  if(new Set(fields.map(([key])=>key)).size!==fields.length||fields.some(([key])=>!["FREQ","INTERVAL","COUNT","UNTIL","BYDAY","BYMONTHDAY","BYMONTH","BYSETPOS","WKST"].includes(key))||fields.some(([key,v])=>["COUNT","INTERVAL"].includes(key)&&(!/^\d+$/.test(v)||Number(v)<1))||fields.some(([key])=>key==="COUNT")&&fields.some(([key])=>key==="UNTIL")) throw new AppError("invalid_input","重复规则字段无效、重复，或 COUNT 与 UNTIL 同时存在。");
  return value;
}
export async function runCalendarTool(env:Runtime,user:string,name:string,args:Arguments):Promise<unknown> {
  if(name==="feishu_list_calendars") {
    const params=calendarPagination(args);
    const data=await apiWithToken(await accessToken(env,user,["calendar:calendar:readonly"]),`/calendar/v4/calendars?${params}`) as Arguments;
    return {...pageResult(data),effective_page_size:Number(params.get("page_size"))};
  }
  const id=eventId(args.calendar_id,"日历 ID"),root=`/calendar/v4/calendars/${encodeURIComponent(id)}/events`;
  if(name==="feishu_list_calendar_events") {
    const start=calendarTime(args.start_time),end=calendarTime(args.end_time);
    if(start.allDay||end.allDay) throw new AppError("invalid_input","查询日程需要带时区的完整开始和结束时间。");
    if(end.milliseconds<=start.milliseconds) throw new AppError("invalid_input","结束时间必须晚于开始时间。");
    const params=calendarPagination(args);params.set("start_time",String(Math.floor(start.milliseconds/1000)));params.set("end_time",String(Math.floor(end.milliseconds/1000)));
    const data=await apiWithToken(await accessToken(env,user,["calendar:calendar:readonly"]),`${root}?${params}`) as Arguments;
    return {...pageResult(data),effective_page_size:Number(params.get("page_size"))};
  }
  const eid=name==="feishu_create_calendar_event"?null:eventId(args.event_id,"日程 ID");
  if(name==="feishu_get_calendar_event") {
    const data=await apiWithToken(await accessToken(env,user,["calendar:calendar:readonly"]),`${root}/${encodeURIComponent(eid!)}`) as {event?:Arguments};
    if(!data.event) throw new AppError("invalid_response","未返回日程详情。",502);
    return {...data,event_hash:await eventHash(data.event)};
  }
  const timezone=args.timezone===undefined?"Asia/Taipei":text(args.timezone,"时区",100);
  const body:Arguments={need_notification:false};
  if(args.summary!==undefined) body.summary=text(args.summary,"标题",300);
  if(args.description!==undefined) body.description=text(args.description,"描述",5000,true);
  if(args.location!==undefined) body.location={name:text(args.location,"地点",500,true)};
  if(args.recurrence!==undefined) body.recurrence=recurrenceRule(args.recurrence);
  const start=args.start_time===undefined?null:calendarTime(args.start_time,timezone),end=args.end_time===undefined?null:calendarTime(args.end_time,timezone);
  if((!!start!==!!end)||(start&&end&&(end.milliseconds<=start.milliseconds||start.allDay!==end.allDay))) throw new AppError("invalid_input","开始和结束必须一起提供，类型一致且结束晚于开始；全天日程的结束日期不包含当天。");
  if(start&&end){body.start_time=start.body;body.end_time=end.body;}
  if(name==="feishu_create_calendar_event"&&(!body.summary||!start||!end)) throw new AppError("invalid_input","创建日程需要标题、开始和结束时间。");
  if(name==="feishu_update_calendar_event"&&Object.keys(body).length===1) throw new AppError("invalid_input","请明确要修改的日程字段。");
  const expected=name==="feishu_update_calendar_event"?identifier(args.expected_event_hash,"日程校验值",/^[A-Za-z0-9_-]{43}$/):null;
  return writeOnce(env,user,name,args,["calendar:calendar"],async token=>{
    if(expected){
      const current=await apiWithToken(token,`${root}/${encodeURIComponent(eid!)}`) as {event?:Arguments};
      if(!current.event||await eventHash(current.event)!==expected) throw new AppError("revision_conflict","日程已有新变化，请重新读取详情后再修改。",409);
    }
    return await apiWithToken(token,eid?`${root}/${encodeURIComponent(eid)}`:root,body,eid?"PATCH":"POST");
  });
}
