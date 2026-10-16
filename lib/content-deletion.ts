import { AppError, safeMessage } from "./core";
import { sha256 } from "./crypto";
import { resolvedDocumentId } from "./documents";
import { callApi, integration, obj, queryPath } from "./integration-common";
import { canonical, identifier, stringField, type Arguments } from "./workspace-common";

const documentField = stringField("docx/wiki 链接或新版文档 ID");
const commentFields = { document: documentField, comment_id: stringField("准确的 comment_id，保留为字符串", 100) };
const hashField = (description: string) => ({ ...stringField(description, 43), pattern: "^[A-Za-z0-9_-]{43}$" });
const precheck = (message: string): never => { throw new AppError("resource_precheck_failed", message + "，无法完成核对。", 409); };

async function replies(token: string, path: string) {
  const items: Arguments[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const data = await callApi(token, queryPath(path + "/replies", { file_type: "docx", user_id_type: "open_id", page_size: 100, page_token: cursor }));
    if (!Array.isArray(data.items) || typeof data.has_more !== "boolean") precheck("评论回复列表或分页状态不完整");
    for (const raw of data.items as unknown[]) {
      const r = obj(raw);
      if (typeof r.reply_id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(r.reply_id) || seen.has(r.reply_id) || typeof r.user_id !== "string" || !Array.isArray(obj(r.content).elements)) precheck("回复 ID、作者或内容缺失，或重复读取到同一回复");
      seen.add(r.reply_id as string);
      const identity = { reply_id: r.reply_id, user_id: r.user_id, content: r.content, create_time: r.create_time ?? null, update_time: r.update_time ?? null, extra: r.extra ?? null };
      items.push({ ...identity, reply_hash: await sha256(canonical(identity)) });
      if (items.length > 500) precheck("评论超过 500 条回复，请使用分页读取核对并逐条处理");
    }
    if (!data.has_more) return items.sort((a, b) => String(a.reply_id).localeCompare(String(b.reply_id)));
    if (typeof data.page_token !== "string" || !data.page_token || data.page_token.length > 4096 || cursors.has(data.page_token)) precheck("评论分页游标缺失或重复");
    cursor = data.page_token as string; cursors.add(cursor);
  }
  return precheck("评论回复分页超过完整核对上限");
}

async function commentMeta(token: string, document: string, id: string) {
  const data = await callApi(token, queryPath(`/drive/v1/files/${document}/comments/batch_query`, { file_type: "docx", user_id_type: "open_id" }), { comment_ids: [id] });
  if (!Array.isArray(data.items)) precheck("评论查询响应不完整");
  const matches = (data.items as unknown[]).map(obj).filter(item => item.comment_id === id);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0].is_whole !== "boolean" || typeof matches[0].is_solved !== "boolean") precheck("评论身份或状态不完整");
  const c = matches[0];
  return { comment_id: id, user_id: c.user_id ?? null, is_whole: c.is_whole, is_solved: c.is_solved, quote: c.quote ?? null, create_time: c.create_time ?? null, update_time: c.update_time ?? null };
}

async function inspectComment(token: string, document: string, id: string) {
  const comment = await commentMeta(token, document, id);
  if (!comment) throw new AppError("comment_not_found", "未找到准确评论或无权读取；未执行删除。", 404);
  const items = await replies(token, `/drive/v1/files/${document}/comments/${id}`);
  const after = await commentMeta(token, document, id);
  if (canonical(after) !== canonical(comment)) throw new AppError("revision_conflict", "评论在读取期间有变化，请重新核对。", 409);
  const snapshot = { document_id: document, comment, replies: items };
  if (canonical(snapshot).length > 180000) precheck("评论内容过长，无法在本次完整展示，请使用分页回复工具核对");
  return { ...snapshot, complete: true, reply_count: items.length, comment_hash: await sha256(canonical(snapshot)), note: "删除整条评论需逐条删除全部回复，包括第一条；已解决和删除是不同操作。回复删除没有撤销接口。" };
}

async function removeReply(token: string, document: string, comment: string, reply: string) {
  await callApi(token, queryPath(`/drive/v1/files/${document}/comments/${comment}/replies/${reply}`, { file_type: "docx" }), undefined, "DELETE");
}

async function commentPresentInList(token: string, document: string, id: string) {
  // A vanished comment can make batch_query/replies fail with 1069301, which
  // officially means an internal error, not "not found". Prove absence through
  // successful complete lists instead. Explicit filters include resolved and
  // local comments that provider defaults could otherwise hide.
  let pages = 0;
  for (const isWhole of [false, true]) for (const isSolved of [false, true]) {
    const cursors = new Set<string>(), seen = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      if (pages++ >= 20) precheck("评论列表复查超过 20 页上限");
      const data = await callApi(token, queryPath(`/drive/v1/files/${document}/comments`, { file_type: "docx", user_id_type: "open_id", is_whole: isWhole, is_solved: isSolved, page_size: 100, page_token: cursor }));
      if (!Array.isArray(data.items) || typeof data.has_more !== "boolean") precheck("评论列表复查响应或分页状态不完整");
      for (const raw of data.items as unknown[]) {
        const comment = obj(raw).comment_id;
        if (typeof comment !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(comment) || seen.has(comment)) precheck("评论列表复查的 ID 缺失、无效或重复");
        if (comment === id) return true;
        seen.add(comment as string);
      }
      if (!data.has_more) break;
      if (typeof data.page_token !== "string" || !data.page_token || data.page_token.length > 4096 || cursors.has(data.page_token)) precheck("评论列表复查的分页游标缺失或重复");
      cursor = data.page_token as string; cursors.add(cursor);
    }
  }
  return false;
}

export const CONTENT_DELETION_INTEGRATIONS = [
  integration("feishu_get_document_comment", "核对整条评论及全部回复", "完整读取指定 docx 评论及回复，返回 comment_hash 和各条 reply_hash，供删除前核对。最多 500 条回复；不把分页或读取失败当成空评论。", commentFields, ["document", "comment_id"], ["docs:document.comment:read"], async (e, u, a, token) => inspectComment(token, await resolvedDocumentId(e, u, a.document), identifier(a.comment_id))),
  integration("feishu_delete_comment_reply", "删除指定评论回复", "仅按用户明确要求删除一条回复，包括评论的第一条回复；保留其余回复。先用 feishu_get_document_comment 核对准确 reply_id 和 reply_hash。删除不可撤销，不会以解决评论代替删除。", { ...commentFields, reply_id: stringField("准确的 reply_id，保留为字符串", 100), expected_reply_hash: hashField("核对工具返回的 reply_hash") }, ["document", "comment_id", "reply_id", "expected_reply_hash"], ["docs:document.comment:read", "docs:document.comment:write_only"], async (e, u, a, token) => {
    const document = await resolvedDocumentId(e, u, a.document), id = identifier(a.comment_id), reply = identifier(a.reply_id);
    const current = await inspectComment(token, document, id), target = current.replies.find(item => item.reply_id === reply);
    if (!target) precheck("没有找到指定回复");
    if (target!.reply_hash !== a.expected_reply_hash) throw new AppError("revision_conflict", "回复已修改，请重新读取后再决定删除。", 409);
    await removeReply(token, document, id, reply);
    return { document_id: document, comment_id: id, reply_id: reply, deleted: true, state: "deleted", scope: "single_reply", last_reply_in_snapshot: current.reply_count === 1, note: current.reply_count === 1 ? "已删除核对时的最后一条回复；飞书可能同时移除整条评论。此回执确认单条回复删除成功。" : "已删除指定回复，未对其他回复发起删除。" };
  }, true, true),
  integration("feishu_delete_document_comment", "删除整条文档评论", "按用户明确要求删除整条评论及其全部回复。先用 feishu_get_document_comment 完整核对 comment_hash。飞书没有单次删除整条讨论的接口，因此逐条删除；中断或并发新增回复会如实返回 partial/verification_required 和已删 ID。仅 deleted=true 才可报告整条已删除。继续处理前重新读取，使用新的 request_id；同一 request_id 只重放已有回执。", { ...commentFields, expected_comment_hash: hashField("完整核对返回的 comment_hash") }, ["document", "comment_id", "expected_comment_hash"], ["docs:document.comment:read", "docs:document.comment:write_only"], async (e, u, a, token) => {
    const document = await resolvedDocumentId(e, u, a.document), id = identifier(a.comment_id), current = await inspectComment(token, document, id);
    if (current.comment_hash !== a.expected_comment_hash) throw new AppError("revision_conflict", "评论或回复已变化，请重新核对后再决定删除。", 409);
    const deleted: string[] = [], deadline = Date.now() + 12000;
    const receipt = () => ({ document_id: document, comment_id: id, deleted_reply_ids: [...deleted], requested_reply_count: current.replies.length });
    for (const item of current.replies) {
      const reply = item.reply_id as string;
      if (deleted.length >= 25 || (deleted.length && Date.now() >= deadline)) return { ...receipt(), deleted: false, state: "partial", remaining_reply_ids: current.replies.slice(deleted.length).map(r => r.reply_id), note: "本次已到批次或时间上限。重新读取这条评论，核对剩余回复后以新的 request_id 继续；不要重试旧请求。" };
      try { await removeReply(token, document, id, reply); deleted.push(reply); }
      catch (error) {
        // Save a partial/uncertain receipt instead of throwing after mutations.
        // Replays must never re-run the already acknowledged deletions.
        const known = error instanceof AppError && ["feishu_api_error", "api_quota_exhausted"].includes(error.kind);
        return { ...receipt(), deleted: false, state: known ? (deleted.length ? "partial" : "failed") : "unknown", failed_reply_id: known ? reply : null, unknown_reply_id: known ? null : reply, remaining_reply_ids: current.replies.slice(deleted.length).map(r => r.reply_id), failure: { kind: error instanceof AppError ? error.kind : "service_error", message: safeMessage(error) }, note: "已停止后续删除；先重新读取核对，不能将部分完成或未知结果当成整条删除成功。" };
      }
    }
    try {
      const meta = await commentMeta(token, document, id);
      const remaining = meta ? await replies(token, `/drive/v1/files/${document}/comments/${id}`) : [];
      return { ...receipt(), deleted: remaining.length === 0, state: remaining.length ? "partial" : "deleted", remaining_reply_ids: remaining.map(r => r.reply_id), verified: true, note: remaining.length ? "仍有回复（可能是并发新增），未删除未经本次核对的新回复。请重新读取核对后继续。" : "全部核对过的回复已删除，复查未发现剩余回复。" };
    } catch (error) {
      try {
        const present = await commentPresentInList(token, document, id);
        return { ...receipt(), deleted: !present, state: present ? "partial" : "deleted", remaining_reply_ids: present ? null : [], verified: true, verification_method: "comment_list", comment_present: present, note: present ? "已收到各条回复删除成功回执，但列表中仍有目标评论；请重新读取核对，不自动删除未经本次核对的新回复。" : "已收到各条回复删除成功回执，并完整检查全文、局部及已解决、未解决评论的列表分页，确认目标评论已消失。" };
      } catch (listError) {
        return { ...receipt(), deleted: false, state: "verification_required", remaining_reply_ids: null, verification_error: safeMessage(error), list_verification_error: safeMessage(listError), note: "已收到各条回复删除成功回执，但详情与列表复查都未能确认整条评论已消失；不能仅凭错误码判断删除成功，请重新读取核对。" };
      }
    }
  }, true, true),
  integration("feishu_delete_document_blocks", "删除指定文档内容块", "按用户明确要求删除同一父块下的一段连续内容及其子块。先读取文档结构，核对父块、expected_revision_id 和按顺序排列的 expected_block_ids；start_index/end_index 为左闭右开。保留其他块，不用于删除整份文档、表格行列或分栏列。", {
    document: documentField, parent_block_id: stringField("包含待删内容的父 block_id", 100), expected_revision_id: { type: "integer", minimum: 1 }, start_index: { type: "integer", minimum: 0 }, end_index: { type: "integer", minimum: 1 }, expected_block_ids: { type: "array", minItems: 1, maxItems: 100, items: { ...stringField("待删除的直接子 block_id", 100), pattern: "^[A-Za-z0-9_-]{8,100}$" } },
  }, ["document", "parent_block_id", "expected_revision_id", "start_index", "end_index", "expected_block_ids"], ["docx:document"], async (e, u, a, token) => {
    const document = await resolvedDocumentId(e, u, a.document), parent = identifier(a.parent_block_id), expected = a.expected_block_ids as string[], start = a.start_index as number, end = a.end_index as number;
    if (end <= start || end - start !== expected.length || new Set(expected).size !== expected.length || expected.includes(document) || expected.includes(parent)) throw new AppError("invalid_input", "删除索引、块数量或目标不匹配。不能把父块或整份文档作为其子块删除。");
    const meta = obj((await callApi(token, `/docx/v1/documents/${document}`)).document);
    if (meta.revision_id !== a.expected_revision_id) throw new AppError("revision_conflict", "文档已更新，请重新读取结构。未执行删除。", 409);
    const block = obj((await callApi(token, queryPath(`/docx/v1/documents/${document}/blocks/${parent}`, { document_revision_id: a.expected_revision_id as number }))).block);
    if (block.block_id !== parent || !Array.isArray(block.children) || end > block.children.length || canonical(block.children.slice(start, end)) !== canonical(expected)) precheck("父块的子块顺序与待删除块不匹配");
    if (block.table || block.grid || [31, 24].includes(Number(block.block_type))) throw new AppError("invalid_input", "此接口不支持删除表格行列或分栏列，请使用相应结构编辑接口。");
    if ((block.table_cell || block.grid_column || block.callout || [32, 25, 19].includes(Number(block.block_type))) && expected.length === (block.children as unknown[]).length) throw new AppError("invalid_input", "飞书不允许清空单元格、分栏列或高亮块的全部子块，请保留至少一个子块。");
    const digest = await sha256(`${u}\0${document}\0feishu_delete_document_blocks\0${a.request_id}`);
    const result = await callApi(token, queryPath(`/docx/v1/documents/${document}/blocks/${parent}/children/batch_delete`, { document_revision_id: a.expected_revision_id as number, client_token: digest }), { start_index: start, end_index: end }, "DELETE");
    if (!Number.isInteger(result.document_revision_id) || Number(result.document_revision_id) <= Number(a.expected_revision_id)) throw new AppError("delete_not_confirmed", "飞书未返回删除后的有效文档版本，请核对结构。", 502);
    return { document_id: document, parent_block_id: parent, deleted_block_ids: expected, deleted: true, state: "deleted", revision_id: result.document_revision_id, includes_descendants: true };
  }, true, true),
];
