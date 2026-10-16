import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import { assertMcpWireResponse } from "./mcp-wire-schema.mjs";
import { announcementCases } from "./announcement-cases.mjs";
import { botCases } from "./bot-cases.mjs";
import { extensionCases } from "./extension-cases.mjs";
import { deletionCommentCases } from "./deletion-comment-cases.mjs";
import { cleanupCases } from "./cleanup-cases.mjs";
import { remainingDeletionCases } from "./remaining-deletion-cases.mjs";
import { metadataPermissionCases } from "./metadata-permission-cases.mjs";
import { commentVerificationCases } from "./comment-verification-cases.mjs";
import { fileStateCases } from "./file-state-cases.mjs";

const directory = path.resolve(".sites-runtime/workspace-tests");
await mkdir(directory, { recursive: true });
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from "cloudflare:workers"/g, 'from "./test-env.mjs"')
  .replace(/from "(?:\.\.\/)+mcp\/route"/g, 'from "./mcp.mjs"')
  .replace(/from "(?:\.\.\/)+lib\/([A-Za-z0-9-]+)"/g, 'from "./$1.mjs"')
  .replace(/from "\.\/([A-Za-z0-9-]+)"/g, 'from "./$1.mjs"');
for (const file of (await readdir("lib")).filter(name => name.endsWith(".ts"))) await writeFile(`${directory}/${file.slice(0,-3)}.mjs`, compile(await readFile(`lib/${file}`, "utf8")));
const load = name => import(pathToFileURL(`${directory}/${name}.mjs`));
const core = await load("core"), cipher = await load("crypto"), features = await load("features"), tables = await load("tables"), calendar = await load("calendars"), chat = await load("chat"), clients = await load("client-access");
const sqlite = new DatabaseSync(":memory:");
for (const file of (await readdir("drizzle")).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(await readFile(`drizzle/${file}`, "utf8"));
const DB = { prepare(sql) { let values = []; return { bind(...args) { values=args; return this; }, async first() { return sqlite.prepare(sql).get(...values)||null; }, async all() { return {results:sqlite.prepare(sql).all(...values)}; }, async run() { return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}; } }; }, async batch(statements) { sqlite.exec("BEGIN"); try { const result=[]; for(const statement of statements) result.push(await statement.run()); sqlite.exec("COMMIT"); return result; } catch(error) {sqlite.exec("ROLLBACK");throw error;} } };
const env = { DB, SITE_ORIGIN:"https://connection.example", FEISHU_APP_ID:"cli_synthetic", FEISHU_APP_SECRET:"synthetic-secret", TOKEN_ENCRYPTION_KEY:"a1".repeat(32), CLIENT_MCP_PUBLIC:"true", SITE_SERVICE_ACCESS:"synthetic-platform" };
globalThis.__workspaceTestEnv=env;
await writeFile(`${directory}/test-env.mjs`,"export const env=globalThis.__workspaceTestEnv;");
for(const [file,name] of [["app/mcp/route.ts","mcp"],["app/auth/feishu/start/route.ts","authorize"],["app/api/resource-download/route.ts","download"],["app/api/bot-status/route.ts","bot-status"]]) await writeFile(`${directory}/${name}.mjs`,compile(await readFile(file,"utf8")));
const mcp=await load("mcp"),authorize=await load("authorize"),download=await load("download");
const allScopes=features.selectedScopes(core.SCOPES,features.EXTRA_FEATURES.map(feature=>feature.id));
for(const [user,scopes] of [["alice",allScopes],["bob",core.SCOPES]]) sqlite.prepare("INSERT INTO feishu_connections (user_id,encrypted_tokens,expires_at,name,open_id,scope,updated_at) VALUES (?,?,?,?,?,?,?)").run(user,await cipher.seal({access_token:"synthetic-"+user},env.TOKEN_ENCRYPTION_KEY,user),Math.floor(Date.now()/1000)+3600,user,"ou_"+user,scopes.join(" "),1);
const rpc=async (name,args={},user="alice",extra={}) => {
  const response=await mcp.POST(new Request(env.SITE_ORIGIN+"/mcp",{method:"POST",headers:{"Content-Type":"application/json",...(user?{"oai-authenticated-user-id":user}:{}),...extra},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}));
  const message = await response.json();
  // A missing/invalid credential is an HTTP OAuth challenge, not an MCP result.
  if (response.status !== 401) assertMcpWireResponse(message, "tools/call");
  return message;
};
const call=async (name,args={},user="alice",extra={}) => (await rpc(name,args,user,extra)).result.structuredContent;
const actualFetch=globalThis.fetch;
const doc=core.documentId("https://my.feishu.cn/docx/AAAAAAAAAAAAAAAAAAAAAAAAAAA"),sheet="SpreadsheetSynthetic",app="BitableSynthetic",table="tblSynthetic",record="recSynthetic",cal="calendar_synthetic@group.calendar.feishu.cn",event="event_synthetic";
let requests=[],handler=()=>Response.json({code:0,data:{}});
globalThis.fetch=async (url,options={})=>{const address=new URL(url);assert.equal(address.origin,"https://open.feishu.cn");assert.equal(options.headers.Authorization,"Bearer synthetic-alice");const request={url:address,path:address.pathname.replace("/open-apis",""),method:options.method,body:options.body instanceof FormData?options.body:options.body?JSON.parse(options.body):undefined};requests.push(request);return handler(request);};
const response=data=>Response.json({code:0,data});
const success=async(name,args)=>{const result=await call(name,args);assert.equal(result.error,undefined,JSON.stringify(result));return result;};
try {
  await metadataPermissionCases({ success, call, requests, response, setHandler: value => { handler = value; }, sqlite, load, env });
  await announcementCases({ success, call, response, requests, setHandler: value => { handler = value; } });
  await botCases({ call, rpc, success, env, route: await load("bot-status") });
  await extensionCases({ success, call, response, requests, setHandler: value => { handler = value; }, sqlite, env, cipher, load });
  await deletionCommentCases({ success, call, rpc, response, requests, setHandler: value => { handler = value; }, sqlite, load });
  await cleanupCases({ success, call, rpc, response, requests, setHandler: value => { handler = value; }, load });
  await remainingDeletionCases({ success, call, rpc, response, requests, setHandler: value => { handler = value; }, load });
  await commentVerificationCases({ success, response, requests, setHandler: value => { handler = value; } });
  await fileStateCases({ success, call, response, requests, setHandler: value => { handler = value; }, sqlite, load });
  const status=await success("feishu_connection_status");assert.equal(status.features.length,features.EXTRA_FEATURES.length);assert.ok(status.features.every(feature=>feature.ready));
  assert.deepEqual(features.missingScopes(["docx:document","sheets:spreadsheet","bitable:app","calendar:calendar"],["docx:document:readonly","sheets:spreadsheet:readonly","bitable:app:readonly","calendar:calendar:readonly"]),[]);
  handler=req=>req.path.includes("get_node")?response({node:{obj_token:doc,obj_type:"docx",node_token:"WikiSynthetic"}}):req.path.endsWith("raw_content")?response({content:"Wiki document"}):req.path.endsWith("/blocks")?response({items:[{block_id:"blockSynthetic",heading1:{elements:[{text_run:{content:"Title"}}]}},{block_id:"imageSynthetic",image:{token:"MediaSynthetic"}},{block_id:"tableSynthetic",table:{cells:["cellSynthetic"],property:{row_size:1,column_size:1}}}],has_more:true,page_token:"next & token"}):response({document:{revision_id:3,title:"Document"}});
  const wiki=await success("feishu_resolve_wiki",{wiki:"https://team.feishu.cn/wiki/WikiSynthetic"});assert.equal(wiki.obj_token,doc);
  assert.equal((await success("feishu_read_document",{document:"https://team.feishu.cn/wiki/WikiSynthetic"})).content,"Wiki document");
  const blocks=await success("feishu_read_document_blocks",{document:doc,limit:20});assert.equal(blocks.revision_id,3);assert.equal(blocks.read_mode,"latest");assert.equal(blocks.complete,false);assert.equal(blocks.page_token,"next & token");assert.equal(blocks.blocks[1].resource_token,"MediaSynthetic");assert.equal(blocks.blocks[2].cells[0],"cellSynthetic");assert.equal(requests.at(-1).url.searchParams.get("document_revision_id"),"-1");
  // Reproduce a viewer who can retrieve metadata and latest structure but is
  // rejected on the provider's numeric-version path.
  handler=req=>req.path.endsWith("/members/auth")?response({auth_result:req.url.searchParams.get("action")==="view"}):req.path.endsWith("/blocks")?(req.url.searchParams.get("document_revision_id")==="-1"?response({items:[{block_id:"viewerBlock",text:{elements:[{text_run:{content:"Latest for viewer"}}]}}],has_more:false}):new Response(JSON.stringify({code:1770032}),{status:403,headers:{"Content-Type":"application/json"}})):response({document:{revision_id:3,title:"Viewer document"}});
  const viewerLatest=await success("feishu_read_document_blocks",{document:doc});assert.equal(viewerLatest.blocks[0].text,"Latest for viewer");assert.equal(viewerLatest.revision_id,3);assert.equal(viewerLatest.read_mode,"latest");
  const viewerVersion=await call("feishu_read_document_blocks",{document:doc,revision_id:3});assert.equal(viewerVersion.provider_code,1770032);assert.equal(viewerVersion.requested_revision,3);assert.equal(viewerVersion.document_access.view,true);assert.equal(viewerVersion.document_access.edit,false);assert.ok(viewerVersion.message.includes("不传 revision_id"));
  handler=req=>req.path.endsWith("/blocks")?response({items:[{block_id:"blockSynthetic",text:{elements:[{text_run:{content:"Authorized block"}}]}}],has_more:false}):new Response(JSON.stringify({code:1770032,error:{log_id:"synthetic-log-123"}}),{status:403,headers:{"Content-Type":"application/json"}});
  const metadataDenied=await success("feishu_read_document_blocks",{document:doc});assert.equal(metadataDenied.blocks[0].text,"Authorized block");assert.equal(metadataDenied.revision_id,null);assert.ok(metadataDenied.metadata_warning);assert.equal(requests.at(-1).url.searchParams.get("document_revision_id"),"-1");
  const pinned=await success("feishu_read_document_blocks",{document:doc,revision_id:7});assert.equal(pinned.revision_id,7);assert.equal(requests.at(-1).url.searchParams.get("document_revision_id"),"7");
  const deniedBefore=requests.length;handler=req=>req.path.endsWith("/members/auth")?response({auth_result:req.url.searchParams.get("action")==="view"}):new Response(JSON.stringify({code:1770032}),{status:403,headers:{"Content-Type":"application/json","x-tt-logid":"synthetic-block-denial"}});
  const deniedBlocks=await call("feishu_read_document_blocks",{document:doc});assert.equal(deniedBlocks.provider_code,1770032);assert.equal(deniedBlocks.provider_path,`/docx/v1/documents/${doc}/blocks`);assert.equal(deniedBlocks.provider_request_id,"synthetic-block-denial");assert.equal(deniedBlocks.blocks,undefined);assert.equal(requests.length,deniedBefore+4,"The blocks API's own rejection must remain an error, never fake successful structure");assert.equal(deniedBlocks.document_access.view,true);assert.equal(deniedBlocks.document_access.edit,false);assert.equal(deniedBlocks.document_access.status,"checked");assert.ok(deniedBlocks.message.includes("阅读权限校验已通过"));
  for(const req of requests.slice(-2)){assert.equal(req.method,"GET");assert.equal(req.body,undefined);assert.equal(req.url.searchParams.get("type"),"docx");}
  handler=req=>req.path.endsWith("/members/auth")?response({auth_result:false}):new Response(JSON.stringify({code:1770032}),{status:403,headers:{"Content-Type":"application/json"}});
  const deniedView=await call("feishu_read_document_blocks",{document:doc});assert.equal(deniedView.document_access.view,false);assert.equal(deniedView.document_access.edit,false);assert.ok(deniedView.message.includes("没有这篇文档的阅读权限"));
  handler=req=>new Response(JSON.stringify({code:req.path.endsWith("/members/auth")?99991679:1770032}),{status:403,headers:{"Content-Type":"application/json"}});
  const unknownView=await call("feishu_read_document_blocks",{document:doc});assert.equal(unknownView.provider_code,1770032);assert.equal(unknownView.document_access.status,"unavailable");assert.equal(unknownView.document_access.view,null);assert.equal(unknownView.document_access.edit,null);assert.equal(unknownView.document_access.checks[0].provider_code,99991679);
  const savedScopes=sqlite.prepare("SELECT scope FROM feishu_connections WHERE user_id='alice'").get().scope;sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(core.SCOPES.join(" "));
  const noDiagnosticScopeBefore=requests.length;const noDiagnosticScope=await call("feishu_read_document_blocks",{document:doc});assert.equal(noDiagnosticScope.document_access.view,null);assert.equal(noDiagnosticScope.document_access.status,"unavailable");assert.equal(noDiagnosticScope.document_access.error,"additional_authorization_required");assert.equal(requests.length,noDiagnosticScopeBefore+2,"Absent Drive scope must skip diagnostic requests without changing the original denial");sqlite.prepare("UPDATE feishu_connections SET scope=? WHERE user_id='alice'").run(savedScopes);
  const outageBefore=requests.length;handler=()=>new Response(JSON.stringify({code:1770034}),{status:500,headers:{"Content-Type":"application/json"}});assert.equal((await call("feishu_read_document_blocks",{document:doc})).provider_code,1770034);assert.equal(requests.length,outageBefore+1,"Do not bypass non-permission metadata errors");
  assert.equal((await call("feishu_append_document",{document:doc,expected_revision_id:null,content:"unsafe",request_id:"document-unknown-revision"})).error,"invalid_input");assert.equal(requests.length,outageBefore+1,"A missing document revision can never authorize an unchecked write");
  handler=req=>{assert.equal(req.path,"/wiki/v2/spaces/123456789/nodes");assert.equal(req.url.searchParams.get("page_token"),"next + & token");return response({items:[],has_more:false});};
  assert.equal((await success("feishu_list_wiki_nodes",{space_id:"123456789",page_token:"next + & token"})).complete,true);
  const before=requests.length;
  for(const args of [{wiki:"https://evil.example/wiki/WikiSynthetic"},{wiki:"https://team.feishu.cn.evil.example/wiki/WikiSynthetic"}]) assert.equal((await call("feishu_resolve_wiki",args)).error,"invalid_input");
  assert.equal(requests.length,before);

  handler=req=>{assert.equal(req.method,"POST");assert.deepEqual(req.body,{title:"Private synthetic title"});return response({document:{document_id:doc}});};
  const createArgs={title:"Private synthetic title",request_id:"document-create-001"};
  const count=requests.length;
  assert.equal((await success("feishu_create_document",createArgs)).replayed,false);
  assert.equal((await success("feishu_create_document",createArgs)).replayed,true);assert.equal(requests.length,count+1);
  assert.equal((await call("feishu_create_document",{...createArgs,title:"Different"})).error,"request_conflict");
  const receipt=sqlite.prepare("SELECT encrypted_result FROM feishu_write_operations WHERE tool_name='feishu_create_document'").get().encrypted_result;
  assert.ok(!receipt.includes(doc));await assert.rejects(()=>cipher.unseal(receipt,env.TOKEN_ENCRYPTION_KEY,"bob"));
  assert.equal((await call("feishu_create_document",{title:"Denied",request_id:"document-denied-001"},"bob")).error,"additional_authorization_required");assert.equal(requests.length,count+1);
  const external=await clients.issueClientKey(env,"alice");
  assert.equal((await call("feishu_create_document",createArgs,"alice",{Authorization:external.headers.Authorization})).error,"mcp_write_authorization_required","External readonly grants never obtain writes");assert.equal(requests.length,count+1);
  handler=req=>req.method==="GET"?response({document:{revision_id:4}}):response({});
  assert.equal((await call("feishu_append_document",{document:doc,expected_revision_id:3,content:"stale",request_id:"document-stale-001"})).error,"revision_conflict");
  handler=req=>{if(req.method==="GET")return response({document:{revision_id:3}});assert.equal(req.url.searchParams.get("document_revision_id"),"3");if(req.method==="POST"){assert.deepEqual(req.body.children.map(block=>block.block_type),[3,12,15,2]);assert.equal(req.body.index,-1);}else{assert.equal(req.method,"PATCH");assert.equal(req.body.update_text_elements.elements[0].text_run.content,"replacement");}return response({document_revision_id:4});};
  await success("feishu_append_document",{document:doc,expected_revision_id:3,content:"# Heading\n- List\n> Quote\nParagraph",request_id:"document-append-001"});
  await success("feishu_update_document_block",{document:doc,block_id:"blockSynthetic",expected_revision_id:3,content:"replacement",request_id:"document-update-001"});

  handler=req=>{if(req.path.endsWith("sheets/query")){assert.equal(req.method,"GET");return response({sheets:[{sheet_id:"abc123"}]});}if(req.path.endsWith("values_batch_get")){assert.equal(req.method,"GET");assert.equal(req.url.searchParams.get("ranges"),"abc123!A1:B2");return response({valueRanges:[{values:[["a",2]]}]});}if(req.path.endsWith("/values")){assert.equal(req.method,"PUT");assert.deepEqual(req.body,{valueRange:{range:"abc123!A1:B2",values:[["a",2],[null,true]]}});return response({updatedCells:4});}assert.equal(req.path,"/sheets/v3/spreadsheets");assert.equal(req.method,"POST");return response({spreadsheet:{spreadsheet_token:sheet}});};
  await success("feishu_list_sheets",{spreadsheet:sheet});await success("feishu_read_sheet",{spreadsheet:sheet,range:"abc123!A1:B2"});
  await success("feishu_write_sheet",{spreadsheet:sheet,range:"abc123!A1:B2",values:[["a",2],[null,true]],request_id:"sheet-write-001"});
  await success("feishu_create_spreadsheet",{title:"Sheet",request_id:"sheet-create-001"});
  for(const bad of ["abc123!A0:B2","abc123!B2:A1","abc123!A1:ZZ1000","../A1","A1:B2"]) assert.throws(()=>tables.sheetRange(bad));
  const badRangeCount=requests.length;assert.equal((await call("feishu_write_sheet",{spreadsheet:sheet,range:"abc123!A1",values:[[1,2]],request_id:"sheet-bad-001"})).error,"invalid_input");assert.equal(requests.length,badRangeCount);
  handler=req=>{assert.ok(req.path.startsWith(`/bitable/v1/apps/${app}/tables`));if(["POST","PUT"].includes(req.method)){assert.deepEqual(req.body,{fields:{Name:"Record",Number:4}});if(req.method==="PUT")assert.ok(req.path.endsWith("/"+record));return response({record:{record_id:record}});}return response({items:[],has_more:true,page_token:"remaining"});};
  await success("feishu_list_bitable_tables",{app});await success("feishu_list_bitable_fields",{app,table_id:table});assert.equal((await success("feishu_read_bitable_records",{app,table_id:table,view_id:"vewSynthetic"})).complete,false);
  await success("feishu_create_bitable_record",{app,table_id:table,fields:{Name:"Record",Number:4},request_id:"bitable-create-001"});
  await success("feishu_update_bitable_record",{app,table_id:table,record_id:record,fields:{Name:"Record",Number:4},request_id:"bitable-update-001"});

  const eventData={summary:"Meeting",start_time:{timestamp:"1791939600",timezone:"Asia/Taipei"},end_time:{timestamp:"1791943200",timezone:"Asia/Taipei"}};
  handler=req=>req.path.endsWith("/calendars")?response({calendar_list:[],has_more:false}):req.path.endsWith("/"+event)?response({event:eventData}):response({items:[],has_more:false});
  await success("feishu_list_calendars");await success("feishu_list_calendar_events",{calendar_id:cal,start_time:"2026-10-14T09:00:00+08:00",end_time:"2026-10-15T09:00:00+08:00"});
  const calendarPage=Array.from({length:50},(_,i)=>({calendar_id:`calendar_${i}`}));
  handler=req=>{const size=Number(req.url.searchParams.get("page_size"));assert.ok(size>=50&&size<=100);return req.path.endsWith("/calendars")?response({calendar_list:calendarPage,has_more:true,page_token:"next + & calendar"}):response({items:calendarPage,has_more:true,page_token:"next + & event"});};
  for(const limit of [1,2,49,50,100]) {
    const actual=await success("feishu_list_calendars",{limit,page_token:"previous + & calendar"});assert.equal(actual.effective_page_size,Math.max(50,limit));assert.equal(actual.calendar_list.length,50,"Do not discard records and skip them when the upstream cursor advances");assert.equal(actual.page_token,"next + & calendar");assert.equal(actual.complete,false);assert.equal(requests.at(-1).url.searchParams.get("page_token"),"previous + & calendar");
    const actualEvents=await success("feishu_list_calendar_events",{calendar_id:cal,start_time:"2026-10-14T09:00:00+08:00",end_time:"2026-10-15T09:00:00+08:00",limit});assert.equal(actualEvents.effective_page_size,Math.max(50,limit));assert.equal(actualEvents.items.length,50);assert.equal(actualEvents.page_token,"next + & event");
  }
  const calendarInvalidBefore=requests.length;for(const limit of [0,101,2.5,"2"])assert.equal((await call("feishu_list_calendars",{limit})).error,"invalid_input");assert.equal(requests.length,calendarInvalidBefore);
  handler=req=>req.path.endsWith("/calendars")?response({calendar_list:[],has_more:false}):req.path.endsWith("/"+event)?response({event:eventData}):response({items:[],has_more:false});
  const eventInfo=await success("feishu_get_calendar_event",{calendar_id:cal,event_id:event});assert.ok(/^[A-Za-z0-9_-]{43}$/.test(eventInfo.event_hash));
  handler=req=>{if(req.method==="GET")return response({event:eventData});assert.equal(req.body.need_notification,false);assert.equal(req.body.attendees,undefined);if(req.method==="POST")assert.deepEqual(req.body.start_time,{date:"2026-10-14"});else{assert.equal(req.method,"PATCH");assert.equal(req.body.summary,"Updated");assert.equal(req.body.start_time,undefined);}return response({event:{event_id:event}});};
  await success("feishu_create_calendar_event",{calendar_id:cal,summary:"Day",start_time:"2026-10-14",end_time:"2026-10-15",request_id:"calendar-create-001"});
  await success("feishu_update_calendar_event",{calendar_id:cal,event_id:event,summary:"Updated",expected_event_hash:eventInfo.event_hash,request_id:"calendar-update-001"});
  handler=()=>response({event:{...eventData,summary:"Changed"}});assert.equal((await call("feishu_update_calendar_event",{calendar_id:cal,event_id:event,summary:"Updated",expected_event_hash:eventInfo.event_hash,request_id:"calendar-stale-001"})).error,"revision_conflict");
  for(const bad of ["2026-02-30","2026-02-30T09:00:00+08:00","2026-10-14T24:00:00+08:00","2026-10-14T09:00:00","bad"]) assert.throws(()=>calendar.calendarTime(bad));

  const png=new Uint8Array([137,80,78,71,13,10,26,10,0]);
  handler=()=>new Response(png,{headers:{"Content-Type":"image/png"}});
  const picture=await rpc("feishu_read_image",{resource_token:"MediaSynthetic"});assert.equal(picture.result.content[1].type,"image");assert.equal(picture.result.content[1].mimeType,"image/png");assert.equal(picture.result.structuredContent._mcp_content,undefined);assert.ok(!picture.result.content[0].text.includes(picture.result.content[1].data));
  const resource=await success("feishu_get_resource_download",{resource_token:"MediaSynthetic",file_name:"图.png"});assert.equal(resource.requires_site_login,true);assert.ok(resource.download_url.startsWith(env.SITE_ORIGIN));
  assert.equal((await download.GET(new Request(resource.download_url))).status,401);
  const notMine=await download.GET(new Request(resource.download_url,{headers:{"oai-authenticated-user-id":"bob"}}));assert.equal(notMine.status,403);
  const own=await download.GET(new Request(resource.download_url,{headers:{"oai-authenticated-user-id":"alice"}}));assert.equal(own.status,200);assert.equal(own.headers.get("cache-control"),"no-store");assert.ok(own.headers.get("content-disposition").includes("%E5%9B%BE.png"));assert.deepEqual(new Uint8Array(await own.arrayBuffer()),png);
  handler=()=>new Response("",{headers:{"Content-Type":"image/png","Content-Length":String(6*1024*1024)}});assert.equal((await call("feishu_read_image",{resource_token:"MediaSynthetic"})).error,"resource_too_large");
  handler=()=>new Response("not an image",{headers:{"Content-Type":"image/png"}});assert.equal((await call("feishu_read_image",{resource_token:"MediaSynthetic"})).error,"unsupported_image");
  handler=()=>new Response('{"data":"an actual JSON file"}',{headers:{"Content-Type":"application/json"}});assert.equal((await success("feishu_get_resource_download",{resource_token:"FileSynthetic",kind:"file"})).content_type,"application/json");
  const oldFetch=globalThis.fetch;let cdnRequests=0;
  globalThis.fetch=async(url,options)=>{if(String(url).startsWith("https://open.feishu.cn/"))return new Response(null,{status:302,headers:{Location:"https://cdn.feishucdn.com/signed-file"}});assert.equal(new URL(url).hostname,"cdn.feishucdn.com");assert.equal(options.headers,undefined,"CDN must never receive Feishu bearer credentials");cdnRequests++;return new Response(png);};
  await success("feishu_read_image",{resource_token:"MediaSynthetic"});assert.equal(cdnRequests,1);
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:"https://evil.example/steal"}});assert.equal((await call("feishu_read_image",{resource_token:"MediaSynthetic"})).error,"provider_redirect");globalThis.fetch=oldFetch;
  assert.equal(chat.messageContent(JSON.stringify({image_key:"img_synthetic123"}),"image").resources[0].kind,"message_image");

  let notify,release;const started=new Promise(resolve=>notify=resolve),blocked=new Promise(resolve=>release=resolve);let simultaneousWrites=0;
  handler=async()=>{simultaneousWrites++;notify();await blocked;return response({document:{document_id:doc}});};
  const concurrentArgs={title:"Concurrent",request_id:"concurrent-write-001"};const first=call("feishu_create_document",concurrentArgs);await started;
  const others=await Promise.all(Array.from({length:20},()=>call("feishu_create_document",concurrentArgs)));assert.ok(others.every(result=>result.error==="write_status_unknown"));assert.equal(simultaneousWrites,1);release();assert.equal((await first).error,undefined);
  const repeat=await success("feishu_create_document",concurrentArgs);assert.equal(repeat.replayed,true);assert.equal(simultaneousWrites,1);
  let uncertainWrites=0;handler=()=>{uncertainWrites++;throw new TypeError("Network interrupted after accept");};const uncertainArgs={title:"Uncertain",request_id:"uncertain-write-001"};assert.equal((await call("feishu_create_document",uncertainArgs)).error,"write_status_unknown");assert.equal((await call("feishu_create_document",uncertainArgs)).error,"write_status_unknown");assert.equal(uncertainWrites,1);
  handler=()=>Response.json({code:99991403},{status:400});assert.equal((await call("feishu_create_document",{title:"Quota",request_id:"quota-write-001"})).error,"api_quota_exhausted");

  const formHeaders={Origin:env.SITE_ORIGIN,"oai-authenticated-user-id":"alice","Content-Type":"application/x-www-form-urlencoded"};
  const selected=await authorize.POST(new Request(env.SITE_ORIGIN+"/auth/feishu/start",{method:"POST",headers:formHeaders,body:"features=wiki&features=document_write"}));assert.equal(selected.status,303);const selectedUrl=new URL(selected.headers.get("location"));assert.ok(selectedUrl.searchParams.get("scope").includes("docx:document"));assert.ok(selectedUrl.searchParams.get("scope").includes("wiki:wiki:readonly"));assert.ok(!selectedUrl.searchParams.get("scope").includes("calendar:calendar"));
  assert.equal((await authorize.POST(new Request(env.SITE_ORIGIN+"/auth/feishu/start",{method:"POST",headers:{...formHeaders,Origin:"https://evil.example"},body:"features=wiki"}))).status,403);
  const unknown=await authorize.POST(new Request(env.SITE_ORIGIN+"/auth/feishu/start",{method:"POST",headers:formHeaders,body:"features=send_bot_messages"}));assert.equal(unknown.headers.get("location"),"/?error=invalid_input");
  const schema=await (await mcp.POST(new Request(env.SITE_ORIGIN+"/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})}))).json();assert.equal(schema.result.tools.length,91);assert.equal(schema.result.tools.filter(tool=>!tool.annotations.readOnlyHint).length,43);assert.ok(!schema.result.tools.some(tool=>/send_message|reply_message|recall/.test(tool.name)));assert.equal(clients.CLIENT_TOOLS.length,91);assert.equal(clients.CLIENT_READ_TOOLS.length,48);assert.equal(clients.CLIENT_WRITE_TOOLS.length,43);
  console.log("PASS: workspace tools; official API paths/methods and payloads; feature scopes and readonly client isolation; wiki and pagination; document revisions; spreadsheet ranges and Bitable fields; calendar time/hash checks; private downloads, image content and credential-safe redirects; encrypted replay receipts; 20 duplicate writes/one provider call; uncertain-write non-replay; selective authorization and CSRF; no bot writes");
} finally {globalThis.fetch=actualFetch;sqlite.close();await rm(directory,{recursive:true,force:true});}
