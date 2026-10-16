import { DOCUMENT_EXTRA_TOOLS, runDocumentTool } from "./documents";
import { RESOURCE_TOOLS, runResourceTool } from "./resources";
import { TABLE_TOOLS, runTableTool } from "./tables";
import { CALENDAR_TOOLS, runCalendarTool } from "./calendars";
import { ANNOUNCEMENT_TOOLS, runAnnouncementTool } from "./announcements";
import { BOT_TOOLS, runBotStatus } from "./bot";
import { EXTENSION_TOOLS, runExtensionTool } from "./extension-tools";
import { AppError } from "./core";
import { type Runtime } from "./feishu";
import { type Arguments } from "./workspace-common";
export const WORKSPACE_TOOLS=[...DOCUMENT_EXTRA_TOOLS,...RESOURCE_TOOLS,...TABLE_TOOLS,...CALENDAR_TOOLS,...ANNOUNCEMENT_TOOLS,...BOT_TOOLS,...EXTENSION_TOOLS];
export const WORKSPACE_READ_TOOLS=WORKSPACE_TOOLS.filter(tool=>tool.annotations.readOnlyHint).map(tool=>tool.name);
export function runWorkspaceTool(env:Runtime,user:string,name:string,args:Arguments) {
  if(BOT_TOOLS.some(tool=>tool.name===name)) return runBotStatus(env,user,args);
  if(EXTENSION_TOOLS.some(tool=>tool.name===name)) return runExtensionTool(env,user,name,args);
  if(ANNOUNCEMENT_TOOLS.some(tool=>tool.name===name)) return runAnnouncementTool(env,user,args);
  if(DOCUMENT_EXTRA_TOOLS.some(tool=>tool.name===name)) return runDocumentTool(env,user,name,args);
  if(RESOURCE_TOOLS.some(tool=>tool.name===name)) return runResourceTool(env,user,name,args);
  if(TABLE_TOOLS.some(tool=>tool.name===name)) return runTableTool(env,user,name,args);
  if(CALENDAR_TOOLS.some(tool=>tool.name===name)) return runCalendarTool(env,user,name,args);
  throw new AppError("unknown_tool","未知工作区工具。");
}
