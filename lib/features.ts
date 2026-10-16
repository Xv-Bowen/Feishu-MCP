import { AppError } from "./core";

// The user-identity metadata API has its own scope. drive:drive:readonly
// alone must not make its preflight look authorized.
export const DRIVE_METADATA_SCOPE = "drive:drive.metadata:readonly";

export const EXTRA_FEATURES = [
  { id: "chat_announcement", title: "群公告读取", scopes: ["im:chat.announcement:read"], write: false },
  { id: "chat_tabs", title: "群会话标签页", scopes: ["im:chat.tabs:read"], write: false },
  { id: "comments_read", title: "文档评论与回复读取", scopes: ["docs:document.comment:read"], write: false },
  { id: "comments_write", title: "添加、回复、解决及删除文档评论和回复", scopes: ["docs:document.comment:write_only", "docs:document.comment:create"], write: true },
  { id: "file_upload", title: "上传文件到云空间", scopes: ["drive:file:upload"], write: true },
  { id: "file_import", title: "导入为飞书云文档", scopes: ["docs:document:import"], write: true },
  { id: "file_export", title: "导出云文档", scopes: ["docs:document:export"], write: false },
  { id: "wiki", title: "知识库链接与目录", scopes: ["wiki:wiki:readonly"], write: false },
  { id: "wiki_delete", title: "核对及删除知识库节点、查询异步结果", scopes: ["wiki:node:retrieve", "wiki:node:create", "wiki:space:read"], write: true },
  { id: "resources", title: "图片与附件读取、下载", scopes: ["drive:drive:readonly"], write: false },
  { id: "file_metadata", title: "云空间文件元数据读取", scopes: [DRIVE_METADATA_SCOPE], write: false },
  { id: "document_write", title: "创建、追加、修改文档及删除内容块", scopes: ["docx:document"], write: true },
  { id: "document_delete", title: "删除整份云空间文档、表格、上传文件、幻灯片及文件夹（移入回收站）", scopes: ["space:document:delete", "drive:drive:readonly", DRIVE_METADATA_SCOPE], write: true },
  { id: "sheets_read", title: "电子表格读取", scopes: ["sheets:spreadsheet:readonly"], write: false },
  { id: "sheets_write", title: "电子表格写入、工作表和样式", scopes: ["sheets:spreadsheet"], write: true },
  { id: "bitable_read", title: "多维表格读取", scopes: ["bitable:app:readonly"], write: false },
  { id: "bitable_write", title: "多维表格建表、写入及删除数据表/记录", scopes: ["bitable:app"], write: true },
  { id: "calendar_read", title: "日历与日程读取", scopes: ["calendar:calendar:readonly"], write: false },
  { id: "calendar_write", title: "日程创建、修改、删除及参会人", scopes: ["calendar:calendar"], write: true },
  { id: "tasks_read", title: "飞书任务读取", scopes: ["task:task:read"], write: false },
  { id: "tasks_write", title: "创建、分派、完成和删除任务", scopes: ["task:task:write"], write: true },
  { id: "tasklists_read", title: "任务清单读取", scopes: ["task:tasklist:read"], write: false },
  { id: "tasklists_write", title: "创建和删除任务清单", scopes: ["task:tasklist:write"], write: true },
  { id: "minutes_read", title: "妙记文字记录", scopes: ["minutes:minutes.transcript:export"], write: false },
] as const;

export const READ_ALTERNATIVES: Record<string, string> = {
  "docx:document:readonly": "docx:document", "sheets:spreadsheet:readonly": "sheets:spreadsheet",
  "bitable:app:readonly": "bitable:app", "calendar:calendar:readonly": "calendar:calendar",
  "docs:document.comment:read": "drive:drive:readonly", "task:task:read": "task:task:write", "task:tasklist:read": "task:tasklist:write",
  "wiki:node:retrieve": "wiki:wiki", "wiki:node:create": "wiki:wiki", "wiki:space:read": "wiki:wiki",
};

export function missingScopes(granted: string[], needed: readonly string[]) {
  return needed.filter(scope => !granted.includes(scope) && !(READ_ALTERNATIVES[scope] && granted.includes(READ_ALTERNATIVES[scope])));
}

export function selectedScopes(base: string[], features: string[]) {
  if (features.some(id => !EXTRA_FEATURES.some(feature => feature.id === id))) throw new AppError("invalid_input", "所选功能无效。");
  return [...new Set([...base, ...EXTRA_FEATURES.filter(feature => features.includes(feature.id)).flatMap(feature => [...feature.scopes])])];
}
