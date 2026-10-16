# 飞书功能与 scope

由 lib/core.ts 和 lib/features.ts 生成；API scope 变化时以飞书官方文档为准。按需授权，不要求每个用户一次性授予全部权限。

基础 scopes：

- `docx:document:readonly`
- `search:docs:read`
- `offline_access`
- `im:chat:read`
- `im:chat.members:read`
- `im:message:readonly`
- `im:message.group_msg:get_as_user`
- `search:message`

| 功能 ID | 功能 | 飞书 scope |
|---|---|---|
| `chat_announcement` | 群公告读取 | `im:chat.announcement:read` |
| `chat_tabs` | 群会话标签页 | `im:chat.tabs:read` |
| `comments_read` | 文档评论与回复读取 | `docs:document.comment:read` |
| `comments_write` | 添加、回复、解决及删除文档评论和回复 | `docs:document.comment:write_only`、`docs:document.comment:create` |
| `file_upload` | 上传文件到云空间 | `drive:file:upload` |
| `file_import` | 导入为飞书云文档 | `docs:document:import` |
| `file_export` | 导出云文档 | `docs:document:export` |
| `wiki` | 知识库链接与目录 | `wiki:wiki:readonly` |
| `wiki_delete` | 核对及删除知识库节点、查询异步结果 | `wiki:node:retrieve`、`wiki:node:create`、`wiki:space:read` |
| `resources` | 图片与附件读取、下载 | `drive:drive:readonly` |
| `file_metadata` | 云空间文件元数据读取 | `drive:drive.metadata:readonly` |
| `document_write` | 创建、追加、修改文档及删除内容块 | `docx:document` |
| `document_delete` | 删除整份云空间文档、表格、上传文件、幻灯片及文件夹（移入回收站） | `space:document:delete`、`drive:drive:readonly`、`drive:drive.metadata:readonly` |
| `sheets_read` | 电子表格读取 | `sheets:spreadsheet:readonly` |
| `sheets_write` | 电子表格写入、工作表和样式 | `sheets:spreadsheet` |
| `bitable_read` | 多维表格读取 | `bitable:app:readonly` |
| `bitable_write` | 多维表格建表、写入及删除数据表/记录 | `bitable:app` |
| `calendar_read` | 日历与日程读取 | `calendar:calendar:readonly` |
| `calendar_write` | 日程创建、修改、删除及参会人 | `calendar:calendar` |
| `tasks_read` | 飞书任务读取 | `task:task:read` |
| `tasks_write` | 创建、分派、完成和删除任务 | `task:task:write` |
| `tasklists_read` | 任务清单读取 | `task:tasklist:read` |
| `tasklists_write` | 创建和删除任务清单 | `task:tasklist:write` |
| `minutes_read` | 妙记文字记录 | `minutes:minutes.transcript:export` |
