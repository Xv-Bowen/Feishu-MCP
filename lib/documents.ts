import { AppError, boundedInteger, documentId } from "./core";
import { accessToken, apiWithToken, type Runtime } from "./feishu";
import { identifier, pagination, pageResult, resourceToken, stringField, text, tool, writeOnce, type Arguments } from "./workspace-common";

const documentField = stringField("飞书 /docx/ 或 /wiki/ 链接，或文档 ID");
const revisionField = { type: "integer", minimum: 0, description: "读取文档结构返回的 revision_id；防止覆盖后来修改的内容。" };
export const DOCUMENT_EXTRA_TOOLS = [
  tool("feishu_resolve_wiki", "解析知识库链接", "将你可访问的知识库链接解析成实际文档、表格或文件 token。", { wiki: stringField("/wiki/ 链接或知识节点 token") }, ["wiki"]),
  tool("feishu_list_wiki_nodes", "查看知识库目录", "读取知识空间或指定节点下一页目录；保留分页，不递归读取全部文档。", { space_id: stringField("知识空间 ID", 100), parent_node_token: stringField("父知识节点 token", 100), limit: { type: "integer", minimum: 1, maximum: 50, default: 50 }, page_token: stringField("分页游标", 4096) }, ["space_id"]),
  tool("feishu_read_document_blocks", "读取文档结构", "默认读取最新的一页标题、段落、列表、表格、图片和附件块及资源 token，返回写入校验所需 revision_id。指定版本读取可能需要文档编辑权限；分段结果可能不包含完整表格。", { document: documentField, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, page_token: stringField("分页游标", 4096), revision_id: {...revisionField,description:"仅在明确需要指定版本时填写；不填读取最新版。历史版本读取需要目标文档的编辑权限。"} }, ["document"]),
  tool("feishu_create_document", "创建飞书文档", "创建标题指定的空文档，可选择文件夹；随后使用追加文档内容填充正文。仅执行用户明确要求的创建操作。", { title: stringField("文档标题", 200), folder_token: stringField("目标文件夹 token，不填则个人根目录", 100) }, ["title"], true),
  tool("feishu_append_document", "追加文档内容", "在文档末尾添加文字、标题、列表或引用块。先读取最新结构，再传 expected_revision_id；不会清空旧内容。", { document: documentField, expected_revision_id: revisionField, content: stringField("正文；支持 # 标题、- 列表、> 引用，每行创建一个块", 20000) }, ["document", "expected_revision_id", "content"], true),
  tool("feishu_update_document_block", "修改文档文字块", "替换指定文字或标题块的文字元素，不删除其他块。会改变该块的文字样式；须明确目标块并先读取最新 revision_id。", { document: documentField, block_id: stringField("读取结构返回的 block_id", 100), expected_revision_id: revisionField, content: { ...stringField("替换后的文字", 20000), minLength: 0 } }, ["document", "block_id", "expected_revision_id", "content"], true, true),
];

export async function wikiNode(env: Runtime, user: string, input: unknown): Promise<Arguments> {
  const token = resourceToken(input, ["wiki"]);
  const data = await apiWithToken(await accessToken(env, user, ["wiki:wiki:readonly"]), `/wiki/v2/spaces/get_node?${new URLSearchParams({ token, obj_type: "wiki" })}`) as { node?: Arguments };
  if (!data.node || typeof data.node.obj_token !== "string") throw new AppError("invalid_response", "飞书未返回知识节点对应的资源。", 502);
  return data.node;
}

export async function resolvedDocumentId(env: Runtime, user: string, input: unknown): Promise<string> {
  if (typeof input === "string" && input.includes(":")) {
    const token = resourceToken(input, ["docx", "wiki"]);
    const url = new URL(input);
    if (url.pathname.startsWith("/wiki/")) {
      const node = await wikiNode(env, user, token);
      if (node.obj_type !== "docx") throw new AppError("unsupported_document", "知识节点对应的是表格或其他资源，请使用对应表格或资源工具。", 400, { resource_type: node.obj_type, resource_token: node.obj_token });
      return documentId(node.obj_token);
    }
  }
  return documentId(input);
}

function elementText(elements: unknown): string {
  if (!Array.isArray(elements)) return "";
  return elements.map(item => {
    const e = item as Arguments;
    if (e.text_run && typeof e.text_run === "object") return String((e.text_run as Arguments).content || "");
    if (e.mention_doc && typeof e.mention_doc === "object") return `[文档:${(e.mention_doc as Arguments).token || ""}]`;
    if (e.mention_user) return "@成员";
    if (e.equation && typeof e.equation === "object") return String((e.equation as Arguments).content || "");
    return "";
  }).join("");
}
export function structuredBlock(raw: Arguments) {
  const names = ["page", "text", ...Array.from({ length: 9 }, (_, i) => "heading" + (i + 1)), "bullet", "ordered", "code", "quote", "todo", "table", "table_cell", "image", "file", "sheet", "bitable", "divider", "callout"];
  const kind = names.find(name => raw[name]) || "other";
  const body = (raw[kind] || {}) as Arguments;
  const content = elementText(body.elements);
  const cells = Array.isArray(body.cells) ? body.cells : [];
  return { block_id: raw.block_id, parent_id: raw.parent_id, children: raw.children || [], kind, text: content.slice(0,12000), text_truncated: content.length > 12000, style: body.style || null,
    ...(Array.isArray(body.elements) ? { elements: body.elements } : {}),
    ...(kind === "image" || kind === "file" ? { resource_token: body.token, resource_kind: "media", file_name: body.name || null } : {}),
    ...(kind === "table" ? { cells, property: body.property || null } : {}), ...(kind === "sheet" || kind === "bitable" ? { embedded: body } : {}) };
}

async function documentAccessChecks(env:Runtime,user:string,doc:string) {
  let token:string;
  try { token=await accessToken(env,user,["drive:drive:readonly"]); }
  catch (error) {
    return {identity:"user_access_token",view:null,edit:null,status:"unavailable",error:error instanceof AppError?error.kind:"permission_check_failed"};
  }
  const checks=await Promise.all(["view","edit"].map(async action=>{
    try {
      const params=new URLSearchParams({type:"docx",action});
      const data=await apiWithToken(token,`/drive/v1/permissions/${doc}/members/auth?${params}`) as {auth_result?:unknown};
      if(typeof data.auth_result!=="boolean") return {action,permitted:null,error:"invalid_response"};
      return {action,permitted:data.auth_result};
    } catch (error) {
      // Failure to run a diagnostic is unknown, never a false permission.
      return {action,permitted:null,error:error instanceof AppError?error.kind:"permission_check_failed",...(error instanceof AppError?error.details:{})};
    }
  }));
  return {identity:"user_access_token",view:checks[0].permitted,edit:checks[1].permitted,status:checks.every(check=>check.permitted!==null)?"checked":"unavailable",checks};
}

export async function runDocumentTool(env: Runtime, user: string, name: string, args: Arguments): Promise<unknown> {
  if (name === "feishu_resolve_wiki") return wikiNode(env, user, args.wiki);
  if (name === "feishu_list_wiki_nodes") {
    const space = identifier(args.space_id, "知识空间 ID", /^\d{8,30}$/), params = pagination(args, 50);
    if (args.parent_node_token !== undefined) params.set("parent_node_token", identifier(args.parent_node_token));
    return pageResult(await apiWithToken(await accessToken(env, user, ["wiki:wiki:readonly"]), `/wiki/v2/spaces/${space}/nodes?${params}`) as Arguments);
  }
  if (name === "feishu_read_document_blocks") {
    const doc = await resolvedDocumentId(env,user,args.document), token = await accessToken(env,user,["docx:document:readonly"]);
    let meta: { document?: { title?: string; revision_id?: number } } = {}, metadataWarning: string | undefined;
    try { meta = await apiWithToken(token,`/docx/v1/documents/${doc}`) as typeof meta; }
    catch (error) {
      if (!(error instanceof AppError) || error.details?.provider_code !== 1770032) throw error;
      // Permission to retrieve basic information can differ from block access.
      // Ask the blocks endpoint under the same user identity; it still enforces
      // its own permissions. Never substitute plaintext for structured blocks.
      metadataWarning="飞书拒绝读取文档基本信息；结构仅由结构块接口的实际返回确认。未取得 revision_id 时请勿据此写入。";
    }
    const requestedRevision = args.revision_id === undefined ? -1 : boundedInteger(args.revision_id,0,0,1_000_000_000);
    // A numeric revision uses Feishu's versioned read path, which can demand
    // edit permission. Keep default reads on the documented latest (-1) path.
    // The pre-read metadata version remains a conservative write guard: an
    // intervening edit causes the existing write-side version check to fail.
    const revision = requestedRevision === -1 ? meta.document?.revision_id : requestedRevision;
    const params = pagination(args);
    params.set("document_revision_id",String(requestedRevision));
    let data:Arguments & {items?:Arguments[]};
    try { data = await apiWithToken(token,`/docx/v1/documents/${doc}/blocks?${params}`) as typeof data; }
    catch (error) {
      if (!(error instanceof AppError) || error.details?.provider_code !== 1770032) throw error;
      const checks=await documentAccessChecks(env,user,doc);
      error.details={...error.details,document_access:checks,requested_revision:requestedRevision};
      if(checks.view===false) error.message="飞书权限校验确认，当前已连接的飞书用户没有这篇文档的阅读权限。请在目标文档的分享设置中给该用户阅读权限，再重试结构读取。";
      else if(checks.view===true && checks.edit===false && requestedRevision!==-1) error.message="当前用户有阅读权限但没有编辑权限，飞书拒绝指定版本读取。请不传 revision_id 读取最新版；历史版本读取需要目标文档的编辑权限。";
      else if(checks.view===true) error.message="飞书的文档阅读权限校验已通过，但结构块接口仍拒绝访问。请结合请求标识核查文档版本、嵌入内容权限及飞书接口访问规则。";
      throw error;
    }
    const blocks = (data.items || []).map(structuredBlock);
    let budget = 100000, truncated = false;
    const visible = blocks.filter(block => { const size = JSON.stringify(block).length; if (size > budget) { truncated = true; return false; } budget -= size; return true; });
    const markdown = visible.map(block => block.kind.startsWith("heading") ? `${"#".repeat(Number(block.kind.slice(7)))} ${block.text}` : block.kind === "bullet" ? `- ${block.text}` : block.kind === "ordered" ? `1. ${block.text}` : block.kind === "quote" ? `> ${block.text}` : block.kind === "image" ? `[图片:${block.resource_token}]` : block.kind === "file" ? `[附件:${block.file_name || block.resource_token}]` : block.kind === "table" ? `[表格: ${block.block_id}，单元格见 cells 与子块]` : block.text).filter(Boolean).join("\n\n");
    return { document_id: doc, title: meta.document?.title, revision_id: revision ?? null, read_mode:requestedRevision===-1?"latest":"specified_revision", ...(metadataWarning ? {metadata_warning:metadataWarning} : {}), blocks: visible, markdown: markdown.slice(0,40000), ...pageResult({ has_more: data.has_more, page_token: data.page_token }), complete: data.has_more !== true && !truncated && !visible.some(block => block.text_truncated), response_truncated: truncated || markdown.length > 40000, note: "按 block_id、children、table.cells 组合结构；分页中缺失的单元格不能当作空白。默认读取最新结构，revision_id 为读取前核查的版本；写入仍须验证当前版本，分页期间内容变化时请重新读取。图片与附件通过资源工具读取。" };
  }
  if (name === "feishu_create_document") {
    const title = text(args.title,"标题",200), folder = args.folder_token === undefined ? undefined : identifier(args.folder_token);
    return writeOnce(env,user,name,args,["docx:document"],async token => {
      const data = await apiWithToken(token,"/docx/v1/documents",{ title, ...(folder ? { folder_token: folder } : {}) }) as { document?: { document_id?: string } };
      return { ...data, document_url: data.document?.document_id ? `https://feishu.cn/docx/${data.document.document_id}` : null };
    });
  }
  const revision = boundedInteger(args.expected_revision_id,-1,0,1_000_000_000);
  const content = text(args.content,"正文",20000,name === "feishu_update_document_block");
  if (!Number.isInteger(args.expected_revision_id)) throw new AppError("invalid_input","请先读取文档结构并提供 expected_revision_id。");
  const block = name === "feishu_update_document_block" ? identifier(args.block_id,"文字块 ID") : null;
  return writeOnce(env,user,name,args,["docx:document"],async token => {
    const doc = await resolvedDocumentId(env,user,args.document);
    const meta = await apiWithToken(token,`/docx/v1/documents/${doc}`) as { document?: { revision_id?: number } };
    if (meta.document?.revision_id !== revision) throw new AppError("revision_conflict","文档已有新修改，请重新读取最新内容后再写入。",409);
    const params = new URLSearchParams({ document_revision_id: String(revision) });
    let result: unknown;
    if (name === "feishu_append_document") {
      const lines = content.split(/\r?\n/);
      if (lines.length > 50) throw new AppError("invalid_input","每次最多追加 50 个段落，请分批追加。");
      const children = lines.map(line => {
        const heading = /^(#{1,9})\s+(.+)$/.exec(line), bullet = /^-\s+(.+)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
        const field = heading ? "heading"+heading[1].length : bullet ? "bullet" : quote ? "quote" : "text";
        return { block_type: heading ? heading[1].length+2 : bullet ? 12 : quote ? 15 : 2, [field]: { elements: [{ text_run: { content: heading?.[2] ?? bullet?.[1] ?? quote?.[1] ?? line, text_element_style: {} } }] } };
      });
      result = await apiWithToken(token,`/docx/v1/documents/${doc}/blocks/${doc}/children?${params}`,{ children, index: -1 });
    } else if (name === "feishu_update_document_block") result = await apiWithToken(token,`/docx/v1/documents/${doc}/blocks/${block}?${params}`,{ update_text_elements: { elements: [{ text_run: { content, text_element_style: {} } }] } },"PATCH");
    else throw new AppError("unknown_tool","未知文档工具。");
    return { document_id: doc, result };
  });
}
