// authen/v1/user_info supplies the current user's name and open_id without
// additional contact scopes. Request only document and messaging reads.
export const DOCUMENT_SCOPES = ["docx:document:readonly", "search:docs:read", "offline_access"];
export const CHAT_SCOPES = ["im:chat:read", "im:chat.members:read", "im:message:readonly", "im:message.group_msg:get_as_user", "search:message"];
export const SCOPES = [...DOCUMENT_SCOPES, ...CHAT_SCOPES];

export class AppError extends Error {
  constructor(public kind: string, message: string, public status = 400, public details?: Record<string, unknown>) { super(message); }
}

export function documentId(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) throw new AppError("invalid_input", "请提供飞书新版文档链接或文档 ID。");
  let id = input.trim();
  if (id.includes(":")) {
    let url: URL;
    try { url = new URL(id); } catch { throw new AppError("invalid_input", "文档链接格式不正确。"); }
    if (url.protocol !== "https:" || url.username || url.password || !/^(?:[a-z0-9-]+\.)*(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(url.hostname)) {
      throw new AppError("invalid_input", "只接受飞书或 Lark 的 HTTPS 文档链接。");
    }
    const match = url.pathname.match(/^\/docx\/([a-zA-Z0-9]{27})\/?$/);
    if (!match) throw new AppError("unsupported_document", "当前支持 /docx/ 新版文档。知识库链接请先打开文档，再复制它的 docx 链接。");
    id = match[1];
  }
  if (!/^[a-zA-Z0-9]{27}$/.test(id)) throw new AppError("invalid_input", "文档 ID 应为 27 位字母或数字。");
  return id;
}

export function boundedInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new AppError("invalid_input", `数值须为 ${min} 到 ${max} 的整数。`);
  return value;
}

export function searchParameters(args: Record<string, unknown>) {
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new AppError("invalid_input", "请输入 1 到 200 个字符的搜索关键词。");
  const count = boundedInteger(args.limit, 10, 1, 50);
  const offset = boundedInteger(args.offset, 0, 0, 198);
  if (offset + count >= 200) throw new AppError("invalid_input", "飞书接口要求 offset + limit 小于 200。");
  return { search_key: args.query.trim(), count, offset, docs_types: ["doc"] };
}

export function documentChunk(content: string, args: Record<string, unknown>) {
  const offset = boundedInteger(args.offset, 0, 0, 100_000_000);
  const limit = boundedInteger(args.max_characters, 16000, 1000, 40000);
  return { content: content.slice(offset, offset + limit), total_characters: content.length, offset, next_offset: offset + limit < content.length ? offset + limit : null, format: "plain_text", note: "纯文本接口不返回图片、附件及原始排版。" };
}

export const TOOLS = [
  { name: "feishu_connection_status", title: "查看飞书连接", description: "检查飞书账号的连接状态，以及文档和群聊权限是否已就绪。未连接时提供连接页面与下一步操作。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "feishu_search_documents", title: "搜索飞书文档", description: "按关键词搜索你有权访问的飞书云文档，返回标题、文档类型与文档 ID，支持分页。", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }, offset: { type: "integer", minimum: 0, maximum: 198, default: 0 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "feishu_read_document", title: "读取飞书文档", description: "读取你有权访问的飞书新版文档正文。支持 /docx/、已授权的 /wiki/ 文档链接或文档 ID；长文档可分段阅读。图片、附件与结构使用对应工具。", inputSchema: { type: "object", properties: { document: { type: "string", description: "飞书 /docx/、/wiki/ 链接或文档 ID", maxLength: 2048 }, offset: { type: "integer", minimum: 0, default: 0 }, max_characters: { type: "integer", minimum: 1000, maximum: 40000, default: 16000 } }, required: ["document"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

export function safeMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "服务暂时不可用，请稍后重试。";
}

export function diagnosticMessage(error: unknown, secrets: Array<string | null | undefined>): string {
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
  message = message.replace(/https?:\/\/[^\s"']+/g, value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return "[URL]"; } });
  return message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").slice(0, 400);
}
