import assert from "node:assert/strict";

export async function extensionCases({success,call,response,requests,setHandler,sqlite,env,cipher,load}) {
  const doc="AAAAAAAAAAAAAAAAAAAAAAAAAAA", chat="oc_synthetic123", msg="om_synthetic123", sheet="SpreadsheetSynthetic", base="BitableSynthetic", table="tblSynthetic", guid="task-synthetic-123", cal="calendar_synthetic@group.calendar.feishu.cn", event="event_synthetic", comment="comment_synthetic";
  let seq=0;const write=(name,args)=>success(name,{...args,request_id:`extension-case-${++seq}`});
  const expected=(path,method,data,inspect=()=>{})=>setHandler(req=>{assert.equal(req.path,path);assert.equal(req.method,method);inspect(req);return response(data);});
  expected(`/im/v1/messages/${msg}`,"GET",{items:[{message_id:msg,msg_type:"text",body:{content:JSON.stringify({text:"长消息".repeat(3000)})}},{message_id:"om_forwarded123",body:{content:'{"text":"second"}'}}]});
  const first=await success("feishu_get_message",{message_id:msg,max_characters:1000});assert.equal(first.next_message_index,1);assert.equal(first.messages[0].next_offset,1000);assert.equal(first.messages[0].complete,false);
  const continuation=await success("feishu_get_message",first.next_arguments);assert.equal(continuation.messages[0].offset,1000);assert.equal(continuation.content_hash,first.content_hash);
  assert.equal((await call("feishu_get_message",{message_id:msg,offset:1000})).error,"invalid_input");
  const second=await success("feishu_get_message",{message_id:msg,message_index:1});assert.equal(second.messages[0].raw_content,'{"text":"second"}');assert.equal(second.next_message_index,null);
  expected(`/im/v1/messages/${msg}`,"GET",{items:[{message_id:msg,msg_type:"text",body:{content:'{"text":"changed"}'}}]});assert.equal((await call("feishu_get_message",first.next_arguments)).error,"message_changed");
  expected(`/im/v1/messages/${msg}/reactions`,"GET",{items:[],has_more:true,page_token:"next & token"},req=>assert.equal(req.url.searchParams.get("reaction_type"),"THUMBSUP"));
  assert.equal((await success("feishu_list_message_reactions",{message_id:msg,reaction_type:"THUMBSUP",limit:50})).complete,false);
  assert.equal((await call("feishu_list_message_reactions",{message_id:msg,limit:51})).error,"invalid_input");
  expected("/im/v1/pins","GET",{items:[{message_id:msg}],has_more:false},req=>assert.equal(req.url.searchParams.get("start_time"),"1792060000000"));
  await success("feishu_list_chat_pins",{chat_id:chat,start_time:"1792060000000",limit:50});
  expected(`/im/v1/chats/${chat}/chat_tabs/list_tabs`,"GET",{chat_tabs:[{tab_id:"tab123",tab_content:{doc:"https://team.feishu.cn/docx/"+doc}}]});await success("feishu_list_chat_tabs",{chat_id:chat});
  expected("/wiki/v2/spaces","GET",{items:[],has_more:true,page_token:"empty-page-next"});assert.equal((await success("feishu_list_wiki_spaces",{})).complete,false);

  expected(`/drive/v1/files/${doc}/comments`,"GET",{items:[{comment_id:comment,has_more:true,page_token:"reply-next",reply_list:{replies:[]}}],has_more:false},req=>{assert.equal(req.url.searchParams.get("is_whole"),"false");assert.equal(req.url.searchParams.get("is_solved"),"true");});
  const comments=await success("feishu_list_document_comments",{document:doc,is_whole:false,is_solved:true});assert.equal(comments.items[0].page_token,"reply-next");assert.equal(comments.complete,true);
  expected(`/drive/v1/files/${doc}/comments/${comment}/replies`,"GET",{items:[],has_more:true,page_token:"r2"});await success("feishu_list_comment_replies",{document:doc,comment_id:comment});
  expected(`/drive/v1/files/${doc}/new_comments`,"POST",{comment_id:comment},req=>{assert.equal(req.body.file_type,"docx");assert.equal(req.body.reply_elements.length,2);assert.ok(req.body.reply_elements.every(item=>Array.from(item.text).length<=1000));assert.equal(req.body.anchor,undefined);});
  await write("feishu_add_document_comment",{document:doc,content:"批注".repeat(700)});
  setHandler(req=>{if(req.path.endsWith("/batch_query")){assert.deepEqual(req.body,{comment_ids:[comment]});return response({items:[{comment_id:comment,is_whole:false,is_solved:false}]});}assert.equal(req.path,`/drive/v1/files/${doc}/comments/${comment}/replies`);assert.equal(req.method,"POST");assert.equal(req.body.content.elements[0].text_run.text,"确认修改");return response({reply_id:"replySynthetic"});});await write("feishu_reply_document_comment",{document:doc,comment_id:comment,content:"确认修改"});
  expected(`/drive/v1/files/${doc}/comments/${comment}`,"PATCH",{},req=>assert.equal(req.body.is_solved,true));await write("feishu_resolve_document_comment",{document:doc,comment_id:comment,is_solved:true});
  const previous=requests.length;assert.equal((await call("feishu_add_document_comment",{document:doc,content:"x",request_id:"missing-comment-scope"},"bob")).error,"additional_authorization_required");assert.equal(requests.length,previous);

  const sheetsPath=`/sheets/v2/spreadsheets/${sheet}/sheets_batch_update`;
  expected(sheetsPath,"POST",{replies:[{}]},req=>assert.equal(req.body.requests[0].addSheet.properties.title,"New"));await write("feishu_add_sheet",{spreadsheet:sheet,title:"New",index:0});
  expected(sheetsPath,"POST",{replies:[{}]},req=>assert.equal(req.body.requests[0].copySheet.source.sheetId,"abc123"));await write("feishu_copy_sheet",{spreadsheet:sheet,sheet_id:"abc123",title:"Copy"});
  let deletes=0;setHandler(req=>req.method==="GET"?response({sheets:[{sheet_id:"abc123",title:"Current"},{sheet_id:"def456",title:"Keep"}]}):(deletes++,assert.equal(req.body.requests[0].deleteSheet.sheetId,"abc123"),response({replies:[{}]})));
  assert.equal((await call("feishu_delete_sheet",{spreadsheet:sheet,sheet_id:"abc123",expected_title:"Wrong",request_id:"stale-sheet-title"})).error,"revision_conflict");assert.equal(deletes,0);await write("feishu_delete_sheet",{spreadsheet:sheet,sheet_id:"abc123",expected_title:"Current"});assert.equal(deletes,1);
  expected(`/sheets/v2/spreadsheets/${sheet}/styles_batch_update`,"PUT",{},req=>assert.equal(req.body.data[0].style.font.fontSize,"12pt/1.5"));await write("feishu_format_sheet",{spreadsheet:sheet,ranges:["abc123!A1:D20"],style:{font:{bold:true,fontSize:"12pt/1.5"},backColor:"#FFFFFF",hAlign:1}});
  for(const style of [{hAlign:3},{font:{fontSize:"50pt/1.5"}},{font:{fontSize:"12pt/1.."}}]) assert.equal((await call("feishu_format_sheet",{spreadsheet:sheet,ranges:["abc123!A1:D20"],style,request_id:"invalid-style"})).error,"invalid_input");
  expected(`/bitable/v1/apps/${base}/tables/${table}/records/search`,"POST",{items:[],has_more:true,page_token:"search-next"},req=>assert.equal(req.body.filter.conditions[0].operator,"contains"));
  assert.equal((await success("feishu_search_bitable_records",{app:base,table_id:table,view_id:"vewSynthetic",filter:{conjunction:"and",conditions:[{field_name:"Title",operator:"contains",value:["update"]}]},sort:[{field_name:"Title",desc:false}]})).complete,false);
  expected(`/bitable/v1/apps/${base}/tables/${table}/records/batch_create`,"POST",{records:[{record_id:"recNew"}]},req=>assert.equal(req.body.records.length,2));await write("feishu_batch_create_bitable_records",{app:base,table_id:table,records:[{fields:{Title:"A"}},{fields:{Title:"B"}}]});
  expected(`/bitable/v1/apps/${base}/tables`,"POST",{table_id:"tblNew"},req=>assert.equal(req.body.table.fields[0].type,1));await write("feishu_create_bitable_table",{app:base,name:"New",default_view_name:"Grid",fields:[{field_name:"Title",type:1}]});

  expected("/drive/v1/files/upload_all","POST",{file_token:"UploadedSynthetic"},req=>{assert.ok(req.body instanceof FormData);assert.equal(req.body.get("parent_type"),"explorer");assert.equal(req.body.get("size"),"5");assert.equal(req.body.get("file").size,5);});
  const uploadArgs={file_name:"hello.txt",data_base64:btoa("hello"),request_id:"upload-once-case"};await success("feishu_upload_file",uploadArgs);const uploadedCount=requests.length;assert.equal((await success("feishu_upload_file",uploadArgs)).replayed,true);assert.equal(requests.length,uploadedCount);
  assert.equal((await call("feishu_upload_file",{file_name:"../bad.txt",data_base64:btoa("x"),request_id:"bad-upload-name"})).error,"invalid_input");
  expected("/drive/v1/import_tasks","POST",{ticket:"ImportTicket"},req=>{assert.equal(req.body.type,"docx");assert.equal(req.body.point.mount_type,1);});await write("feishu_create_import",{file_token:"UploadedSynthetic",file_extension:"txt",target_type:"docx",file_name:"Imported"});
  expected("/drive/v1/import_tasks/ImportTicket","GET",{result:{job_status:0,token:""}});assert.equal((await success("feishu_get_import",{ticket:"ImportTicket"})).state,"pending");
  expected("/drive/v1/import_tasks/ImportTicket","GET",{result:{job_status:0,token:doc}});assert.equal((await success("feishu_get_import",{ticket:"ImportTicket"})).state,"succeeded");
  expected("/drive/v1/export_tasks","POST",{ticket:"ExportTicket"},req=>assert.deepEqual(req.body,{token:doc,type:"docx",file_extension:"pdf"}));await write("feishu_create_export",{resource:doc,resource_type:"docx",file_extension:"pdf"});
  const exportBefore=requests.length;assert.equal((await call("feishu_create_export",{resource:sheet,resource_type:"sheet",file_extension:"csv",request_id:"csv-no-subid"})).error,"invalid_input");assert.equal(requests.length,exportBefore);
  expected("/drive/v1/export_tasks/ExportTicket","GET",{result:{job_status:0,file_token:"ExportedSynthetic",file_name:"doc.pdf"}},req=>assert.equal(req.url.searchParams.get("token"),doc));assert.equal((await success("feishu_get_export",{ticket:"ExportTicket",resource_token:doc})).requires_site_login,true);

  expected("/calendar/v4/freebusy/list","POST",{freebusy_list:[]},req=>{assert.equal(req.body.time_min,"2026-10-16T09:00:00+08:00");assert.equal(req.body.user_id,"ou_alice");});await success("feishu_query_freebusy",{user_id:"ou_alice",start_time:"2026-10-16T09:00:00+08:00",end_time:"2026-10-17T09:00:00+08:00"});
  expected(`/calendar/v4/calendars/${encodeURIComponent(cal)}/events/${event}/attendees`,"GET",{items:[],has_more:false});await success("feishu_list_calendar_attendees",{calendar_id:cal,event_id:event,limit:10});
  const calendar=await load("calendars"),eventData={summary:"Invite",start_time:{timestamp:"1792141200"},end_time:{timestamp:"1792144800"}};
  setHandler(req=>req.method==="GET"?response({event:eventData}):(assert.equal(req.body.need_notification,false),assert.equal(req.body.attendees[0].type,"user"),response({attendees:req.body.attendees})));
  await write("feishu_add_calendar_attendees",{calendar_id:cal,event_id:event,expected_event_hash:await calendar.eventHash(eventData),attendees:[{user_id:"ou_alice"}]});
  assert.throws(()=>calendar.recurrenceRule("FREQ=DAILY;COUNT=2;UNTIL=20261020T000000Z"));assert.equal(calendar.recurrenceRule("RRULE:FREQ=WEEKLY;BYDAY=MO"),"FREQ=WEEKLY;BYDAY=MO");
  expected(`/calendar/v4/calendars/${encodeURIComponent(cal)}/events`,"POST",{event:{event_id:event}},req=>assert.equal(req.body.recurrence,"FREQ=WEEKLY;BYDAY=MO"));await write("feishu_create_calendar_event",{calendar_id:cal,summary:"Recurring",start_time:"2026-10-16T09:00:00+08:00",end_time:"2026-10-16T10:00:00+08:00",recurrence:"FREQ=WEEKLY;BYDAY=MO"});

  expected("/task/v2/tasks","GET",{items:[],has_more:false},req=>assert.equal(req.url.searchParams.get("type"),"my_tasks"));await success("feishu_list_tasks",{completed:false});
  expected("/task/v2/tasks","POST",{task:{guid}},req=>{assert.equal(req.body.members[0].id,"ou_alice");assert.equal(req.body.members[0].role,"assignee");assert.equal(req.body.due.timestamp,String(Date.parse("2026-10-16T18:00:00+08:00")));});await write("feishu_create_task",{summary:"Review",due:"2026-10-16T18:00:00+08:00"});
  const taskData={guid,summary:"Review",completed_at:"1792141200000",updated_at:"1792141200000"};expected(`/task/v2/tasks/${guid}`,"GET",{task:taskData});const task=await success("feishu_get_task",{task_guid:guid});
  const finishBefore=requests.length;const noOp=await write("feishu_update_task",{task_guid:guid,expected_task_hash:task.task_hash,completed:true});assert.equal(noOp.unchanged,true);assert.equal(requests.length,finishBefore+1);
  setHandler(req=>req.method==="GET"?response({task:taskData}):(assert.deepEqual(req.body.update_fields,["summary"]),assert.equal(req.body.task.completed_at,undefined),response({task:{...taskData,summary:"Changed"}})));await write("feishu_update_task",{task_guid:guid,expected_task_hash:task.task_hash,summary:"Changed",completed:true});
  setHandler(req=>req.method==="GET"?response({task:taskData}):(assert.equal(req.path,`/task/v2/tasks/${guid}/add_members`),assert.equal(req.body.members[0].type,"user"),response({task:taskData})));await write("feishu_change_task_members",{task_guid:guid,expected_task_hash:task.task_hash,operation:"add",members:[{id:"ou_alice",role:"follower"}]});
  expected("/task/v2/tasklists","GET",{items:[],has_more:true,page_token:"list-next"});assert.equal((await success("feishu_list_tasklists",{})).has_more,true);
  expected("/task/v2/tasklists","POST",{tasklist:{guid:"list-synthetic"}},req=>assert.equal(req.body.name,"Personal"));await write("feishu_create_tasklist",{name:"Personal"});
  expected("/task/v2/tasklists/list-synthetic/tasks","GET",{items:[],has_more:false});await success("feishu_list_tasklist_tasks",{tasklist_guid:"list-synthetic"});
  setHandler(req=>{assert.equal(req.path,"/minutes/v1/minutes/MinutesSynthetic/transcript");assert.equal(req.url.searchParams.get("need_speaker"),"true");return new Response("00:00 Speaker: "+"word ".repeat(500),{headers:{"Content-Type":"text/plain"}});});const transcript=await success("feishu_read_minutes",{minutes:"https://team.feishu.cn/minutes/MinutesSynthetic",max_characters:1000});assert.equal(transcript.next_offset,1000);
  setHandler(()=>Response.json({code:99991672},{status:403}));assert.equal((await call("feishu_read_minutes",{minutes:"MinutesSynthetic"})).error,"feishu_api_error");

  await watchCases({success,call,response,requests,setHandler,sqlite,env,cipher,write,chat});
  console.log("PASS: extension API contracts, full-message/merged-forward pagination, comment/reply pagination and scope denial, worksheet deletion guard, styles, Bitable filter/batch/table, binary upload replay, import/export states, busy/attendees/recurrence, task no-op completion, raw Minutes and encrypted watch recovery");
}

async function watchCases({success,call,response,requests,setHandler,sqlite,env,cipher,write,chat}) {
  const realNow=Date.now;let clock=Math.floor(realNow()/1000)*1000;Date.now=()=>clock;
  try {
    const watch=await write("feishu_create_watch",{name:"Test changes",chat_id:chat,chat_mode:"topic",keywords:["示例产品输入法"],include_announcements:false});const id=watch.watch_id;
    assert.equal((await call("feishu_list_watches",{},"bob")).watches.length,0);
    assert.equal((await call("feishu_list_watch_events",{watch_id:id},"bob")).error,"invalid_input");
    clock+=10000;
    const newMsg={message_id:"om_newmessage123",chat_id:chat,msg_type:"post",create_time:String(clock-5000),body:{content:JSON.stringify({content:[[{tag:"text",text:"示例产品"},{tag:"text",text:"输入法发布更新"}]]})}};
    let page=0;
    setHandler(req=>{assert.equal(req.url.searchParams.get("only_thread_root_messages"),"false");page++;return response(page===1?{items:[newMsg],has_more:true,page_token:"pending-next"}:{items:[],has_more:false});});
    const partial=await write("feishu_check_watch",{watch_id:id,max_pages:1});assert.equal(partial.complete,false);
    let state=await cipher.unseal(sqlite.prepare("SELECT encrypted_state FROM feishu_watches WHERE id=?").get(id).encrypted_state,env.TOKEN_ENCRYPTION_KEY,"alice");assert.equal(state.window.page_token,"pending-next");assert.ok(state.cursor<clock/1000);assert.equal((await success("feishu_list_watch_events",{watch_id:id})).events.length,1);
    await write("feishu_update_watch",{watch_id:id,include_messages:false,include_announcements:true});assert.equal((await success("feishu_list_watches",{})).watches.find(x=>x.watch_id===id).has_pending_pages,false,"Paused streams must not appear as active pagination");
    await write("feishu_update_watch",{watch_id:id,include_messages:true,include_announcements:false});
    clock+=1000;await write("feishu_check_watch",{watch_id:id,max_pages:1});assert.equal(requests.at(-1).url.searchParams.get("page_token"),"pending-next");
    state=await cipher.unseal(sqlite.prepare("SELECT encrypted_state FROM feishu_watches WHERE id=?").get(id).encrypted_state,env.TOKEN_ENCRYPTION_KEY,"alice");assert.equal(state.window,undefined);
    setHandler(()=>response({items:[newMsg],has_more:false}));await write("feishu_check_watch",{watch_id:id});assert.equal((await success("feishu_list_watch_events",{watch_id:id})).events.length,1,"Overlap/retry must not duplicate an event");
    const events=await success("feishu_list_watch_events",{watch_id:id});assert.ok(events.events[0].content.includes("示例产品输入法"));
    await write("feishu_ack_watch_events",{watch_id:id,event_ids:[events.events[0].event_id]});assert.equal((await success("feishu_list_watch_events",{watch_id:id})).events.length,0);assert.equal((await success("feishu_list_watch_events",{watch_id:id,include_reported:true})).events.length,1);
    const stored=sqlite.prepare("SELECT encrypted_payload FROM feishu_watch_events WHERE watch_id=?").get(id).encrypted_payload;assert.ok(!stored.includes("示例产品"));
    await write("feishu_update_watch",{watch_id:id,enabled:false});const before=requests.length;assert.equal((await write("feishu_check_watch",{watch_id:id})).paused,true);assert.equal(requests.length,before);
    await write("feishu_update_watch",{watch_id:id,enabled:true});
    sqlite.prepare("UPDATE feishu_watches SET lock='other',lock_expires_at=? WHERE id=?").run(clock/1000+60,id);assert.equal((await call("feishu_check_watch",{watch_id:id,request_id:"watch-contention"})).error,"watch_busy");sqlite.prepare("UPDATE feishu_watches SET lock=NULL WHERE id=?").run(id);

    const announcement=await write("feishu_create_watch",{name:"Announcement",chat_id:chat,chat_mode:"topic",include_messages:false,include_announcements:true});let revision=1,content="Old announcement";
    setHandler(req=>req.path.endsWith("/blocks")?response({items:[{text:{elements:[{text_run:{content}}]}}],has_more:false}):response({announcement_type:"docx",revision_id:revision,update_time:revision+100}));
    await write("feishu_check_watch",{watch_id:announcement.watch_id});assert.equal((await success("feishu_list_watch_events",{watch_id:announcement.watch_id})).events.length,0,"First read is a baseline");revision=2;content="New announcement";await write("feishu_check_watch",{watch_id:announcement.watch_id});const changes=await success("feishu_list_watch_events",{watch_id:announcement.watch_id});assert.equal(changes.events.length,1);assert.equal(changes.events[0].added,"New");assert.equal(changes.events[0].removed,"Old");
    await write("feishu_check_watch",{watch_id:announcement.watch_id});assert.equal((await success("feishu_list_watch_events",{watch_id:announcement.watch_id})).events.length,1);

    const group=await write("feishu_create_watch",{name:"Threads",chat_id:chat,chat_mode:"group",include_announcements:false});
    setHandler(req=>{if(req.url.searchParams.get("container_id_type")==="chat")return response({items:[{thread_id:"omt_broken123"},{thread_id:"omt_working123"}],has_more:false});if(req.url.searchParams.get("container_id")==="omt_broken123")return Response.json({code:230050},{status:403});return response({items:[{...newMsg,message_id:"om_workingreply123",create_time:String(clock)}],has_more:false});});
    const scanned=await write("feishu_check_watch",{watch_id:group.watch_id});assert.equal(scanned.complete,false);assert.equal((await success("feishu_list_watch_events",{watch_id:group.watch_id})).events.length,1,"Broken thread must not prevent checking another thread");
    const groups=(await success("feishu_list_watches",{})).watches;assert.ok(groups.find(x=>x.watch_id===group.watch_id).errors.some(x=>x.thread_id==="omt_broken123"));
    await write("feishu_delete_watch",{watch_id:id});assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM feishu_watch_events WHERE watch_id=?").get(id).n,0);
  } finally {Date.now=realNow;}
}
