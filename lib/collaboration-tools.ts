import { documentChunk, AppError } from "./core";
import { messageContent } from "./chat";
import { sha256 } from "./crypto";
import { resolvedDocumentId } from "./documents";
import { identifier, pagination, pageResult, pagingFields, stringField, text } from "./workspace-common";
import { boolField, callApi, integration, obj, queryPath } from "./integration-common";

const chat = { ...stringField("群聊 ID", 104), pattern: "^oc_[A-Za-z0-9_-]{8,100}$" };
const message = { ...stringField("消息 ID", 104), pattern: "^om_[A-Za-z0-9_-]{8,100}$" };
const doc = stringField("飞书 docx/wiki 链接或新版文档 ID");
const comment = stringField("读取评论返回的 comment_id", 100);
const commentsBase = { document: doc, comment_id: comment };
const commentsPath = async (env: Parameters<typeof resolvedDocumentId>[0], user: string, input: unknown) => `/drive/v1/files/${await resolvedDocumentId(env, user, input)}/comments`;
const commentText = (value: string) => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function replySupport(value: unknown) {
  const item = obj(value);
  const reason = item.is_whole === true ? "whole_document_comment" : item.is_solved === true ? "solved_comment" : typeof item.is_whole !== "boolean" || typeof item.is_solved !== "boolean" ? "unknown_comment_state" : null;
  return { ...item, can_reply: reason === null ? true : reason === "unknown_comment_state" ? null : false, reply_unavailable_reason: reason };
}

export const COLLABORATION_INTEGRATIONS = [
  integration("feishu_get_message", "读取单条消息全文", "按消息 ID 取得可见消息原文与元信息。正文使用 next_arguments 续读并校验内容未变化；合并转发通过 next_message_index 逐条读取。", { message_id: message, message_index: { type: "integer", minimum: 0, maximum: 10000, default: 0 }, offset: { type: "integer", minimum: 0 }, max_characters: { type: "integer", minimum: 1000, maximum: 40000 }, expected_content_hash: stringField("续读时使用返回的 content_hash，防止拼接不同版本", 100) }, ["message_id"], ["im:message:readonly", "im:message.group_msg:get_as_user"], async (_e, _u, a, token) => {
    const data = await callApi(token, `/im/v1/messages/${encodeURIComponent(a.message_id as string)}?user_id_type=open_id&with_sender_name=true&card_msg_content_type=user_card_content`);
    const items = Array.isArray(data.items) ? data.items.map(obj) : [];
    const index = Number(a.message_index || 0); if (!items[index]) throw new AppError("invalid_input", "未找到该条消息，或 message_index 超出合并转发范围。");
    const item = items[index], raw = item.deleted === true ? "" : typeof obj(item.body).content === "string" ? obj(item.body).content as string : "", contentHash = await sha256(JSON.stringify([item.message_id, item.update_time, raw]));
    if (Number(a.offset || 0) > 0 && !a.expected_content_hash) throw new AppError("invalid_input", "消息续读请使用上一页 next_arguments。");
    if (a.expected_content_hash && a.expected_content_hash !== contentHash) throw new AppError("message_changed", "消息已变化，请从头重新读取。", 409);
    const chunk = documentChunk(raw, a);
    return { messages: [{ ...item, body: undefined, readable_preview: messageContent(raw, String(item.msg_type || "unknown")), raw_content: chunk.content, offset: chunk.offset, next_offset: chunk.next_offset, total_characters: raw.length, complete: chunk.next_offset === null }], content_hash: contentHash, next_arguments: chunk.next_offset === null ? null : { message_id: a.message_id, message_index: index, offset: chunk.next_offset, max_characters: a.max_characters || 16000, expected_content_hash: contentHash }, message_id: a.message_id, message_index: index, total_messages: items.length, next_message_index: index + 1 < items.length ? index + 1 : null };
  }),
  integration("feishu_list_message_reactions", "查看消息表情反馈", "读取一页消息表情回复，可按表情类型筛选。", { message_id: message, reaction_type: stringField("可选 emoji_type，例如 THUMBSUP", 100), ...pagingFields, limit: { type: "integer", minimum: 1, maximum: 50, default: 50 } }, ["message_id"], ["im:message:readonly"], async (_e, _u, a, token) => {
    const p = pagination(a, 50); p.set("user_id_type", "open_id"); if (a.reaction_type) p.set("reaction_type", a.reaction_type as string);
    return pageResult(await callApi(token, `/im/v1/messages/${a.message_id}/reactions?${p}`));
  }),
  integration("feishu_list_chat_pins", "读取群内 Pin 消息", "读取群内一页 Pin 消息，按消息 ID 使用单条消息工具核对完整原文。时间筛选是 Pin 创建时间，单位毫秒。", { chat_id: chat, ...pagingFields, limit: { type: "integer", minimum: 1, maximum: 50, default: 50 }, start_time: stringField("可选 Unix 毫秒时间戳", 20), end_time: stringField("可选 Unix 毫秒时间戳", 20) }, ["chat_id"], ["im:message:readonly"], async (_e, _u, a, token) => {
    const p = pagination(a, 50); p.set("chat_id", a.chat_id as string);
    for (const key of ["start_time", "end_time"]) if (a[key] !== undefined) p.set(key, identifier(a[key], key, /^\d{1,13}$/));
    if (a.start_time && a.end_time && Number(a.start_time) >= Number(a.end_time)) throw new AppError("invalid_input", "结束时间必须晚于开始时间。");
    return pageResult(await callApi(token, `/im/v1/pins?${p}`));
  }),
  integration("feishu_list_chat_tabs", "读取群标签页", "列出群会话标签页及飞书返回的文档、网址等入口，不代表已读取这些链接的内容。", { chat_id: chat }, ["chat_id"], ["im:chat.tabs:read"], async (_e, _u, a, token) => callApi(token, `/im/v1/chats/${a.chat_id}/chat_tabs/list_tabs`)),
  integration("feishu_list_wiki_spaces", "查看可访问知识空间", "列出一页可访问的知识空间。has_more=true 时即使本页为空也应继续翻页。", { ...pagingFields, limit: { type: "integer", minimum: 1, maximum: 50, default: 50 } }, [], ["wiki:wiki:readonly"], async (_e, _u, a, token) => pageResult(await callApi(token, `/wiki/v2/spaces?${pagination(a, 50)}`))),
  integration("feishu_list_document_comments", "读取文档评论", "读取新版文档的全文或局部评论。is_whole/is_solved 可筛选；不指定时按飞书默认过滤，不能据此声称包含全部已解决评论。评论内 reply_list 也可能另有分页。", { document: doc, is_whole: boolField, is_solved: boolField, ...pagingFields }, ["document"], ["docs:document.comment:read"], async (e, u, a, token) => {
    const p = pagination(a); p.set("file_type", "docx"); p.set("user_id_type", "open_id");
    for (const key of ["is_whole", "is_solved"]) if (a[key] !== undefined) p.set(key, String(a[key]));
    const data = await callApi(token, `${await commentsPath(e, u, a.document)}?${p}`);
    return { ...pageResult(data), ...(Array.isArray(data.items) ? { items: data.items.map(replySupport) } : {}), filters: { is_whole: a.is_whole ?? "provider_default", is_solved: a.is_solved ?? "provider_default" }, note: "complete 仅表示当前筛选条件下的评论列表分页完成；评论回复若 has_more=true 需单独续读。全文评论和已解决评论不能追加回复；can_reply 仅表示评论类型和状态允许，仍须具有写入权限。" };
  }),
  integration("feishu_list_comment_replies", "读取评论回复", "读取指定文档评论的一页回复。", { ...commentsBase, ...pagingFields }, ["document", "comment_id"], ["docs:document.comment:read"], async (e, u, a, token) => {
    const p = pagination(a); p.set("file_type", "docx"); p.set("user_id_type", "open_id");
    return pageResult(await callApi(token, `${await commentsPath(e, u, a.document)}/${encodeURIComponent(identifier(a.comment_id))}/replies?${p}`));
  }),
  integration("feishu_add_document_comment", "添加文档全文评论", "按用户明确要求在新版文档添加全文评论，不定位选中文字，不自动 @ 他人。飞书全文评论不支持追加回复；需要回复时须选择已有的未解决局部评论。", { document: doc, content: stringField("评论文字", 10000) }, ["document", "content"], ["docs:document.comment:write_only"], async (e, u, a, token) => {
    const id = await resolvedDocumentId(e, u, a.document), content = text(a.content, "评论文字", 10000);
    const points = Array.from(content), reply_elements = []; for (let i = 0; i < points.length; i += 1000) reply_elements.push({ type: "text", text: commentText(points.slice(i, i + 1000).join("")) });
    return callApi(token, `/drive/v1/files/${id}/new_comments`, { file_type: "docx", reply_elements });
  }, true),
  integration("feishu_reply_document_comment", "回复文档评论", "按用户明确要求回复指定的未解决局部评论。飞书不支持回复全文评论（is_whole=true）或已解决评论；先读取评论核对状态，不自动新增评论或恢复已解决评论。", { ...commentsBase, content: stringField("回复文字", 10000) }, ["document", "comment_id", "content"], ["docs:document.comment:read", "docs:document.comment:create"], async (e, u, a, token) => {
    const path = await commentsPath(e, u, a.document), id = identifier(a.comment_id), content = commentText(text(a.content, "回复文字", 10000));
    // Batch query supports both local and whole comments, including solved
    // comments. The single-comment GET is documented as whole-comment only.
    const data = await callApi(token, queryPath(`${path}/batch_query`, { file_type: "docx", user_id_type: "open_id" }), { comment_ids: [id] });
    const current = Array.isArray(data.items) ? data.items.map(obj).find(item => item.comment_id === id) : undefined;
    if (!current) throw new AppError("comment_not_found", "未找到指定评论，或当前用户无权读取；未提交回复。", 404);
    if (current.is_whole === true) throw new AppError("comment_reply_not_supported", "飞书不支持回复全文评论（is_whole=true）。请选择已有的未解决局部评论；如需另发全文评论，请明确要求新增评论。未提交任何回复。", 400, { comment_id: id, reason: "whole_document_comment" });
    if (current.is_solved === true) throw new AppError("comment_already_solved", "该评论已解决，飞书不允许追加回复。需要继续讨论时，请先明确要求恢复此评论。未自动恢复评论或提交回复。", 409, { comment_id: id, reason: "solved_comment" });
    if (current.is_whole !== false || current.is_solved !== false) throw new AppError("resource_precheck_failed", "飞书未返回完整的评论类型和状态，未提交回复。", 502);
    return callApi(token, queryPath(`${path}/${encodeURIComponent(id)}/replies`, { file_type: "docx", user_id_type: "open_id" }), { content: { elements: [{ type: "text_run", text_run: { text: content } }] } });
  }, true),
  integration("feishu_resolve_document_comment", "解决或恢复文档评论", "把指定评论标为已解决或未解决。先读取确认目标评论，只执行用户明确要求的状态变更。", { ...commentsBase, is_solved: boolField }, ["document", "comment_id", "is_solved"], ["docs:document.comment:write_only"], async (e, u, a, token) => callApi(token, queryPath(`${await commentsPath(e, u, a.document)}/${encodeURIComponent(identifier(a.comment_id))}`, { file_type: "docx" }), { is_solved: a.is_solved }, "PATCH"), true, true),
];
