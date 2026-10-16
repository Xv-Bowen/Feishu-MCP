import { AppError } from "./core";
import { DRIVE_METADATA_SCOPE } from "./features";
import { sha256 } from "./crypto";
import { accessToken } from "./feishu";
import { boolField, callApi, enumField, integration, obj, queryPath } from "./integration-common";
import { canonical, identifier, resourceToken, stringField, type Arguments } from "./workspace-common";

const hashField = { ...stringField("核对工具返回的 snapshot_hash", 43), pattern: "^[A-Za-z0-9_-]{43}$" };
const folderField = stringField("明确的 /drive/folder/ 链接或文件夹 token；不接受个人根目录");
const wikiFields = { wiki: stringField("准确的 /wiki/ 链接或 node_token；不接受底层文档 token"), include_children: { ...boolField, description: "true 删除全部后代节点；false 保留子节点并由飞书移到上一级，必须明确选择" } };
const precheck = (message: string): never => { throw new AppError("resource_precheck_failed", message + "；未执行删除。", 409); };
const compare = (actual: unknown, expected: unknown) => { if (actual !== expected) throw new AppError("revision_conflict", "目标名称、目录内容或删除范围已变化，请重新核对。未执行删除。", 409); };

function folderToken(input: unknown): string {
  if (typeof input === "string" && input.includes(":")) {
    let url: URL; try { url = new URL(input); } catch { throw new AppError("invalid_input", "文件夹链接无效。"); }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "drive" || parts[1] !== "folder") throw new AppError("invalid_input", "请提供准确的 /drive/folder/ 链接。");
    url.pathname = `/folder/${parts[2]}`;
    return resourceToken(url.toString(), ["folder"]);
  }
  return identifier(input, "文件夹 token");
}

// Explicit bounds and strict pagination: never label a partial traversal complete.
async function pages(token: string, path: string, params: Record<string, string | number>, field: string, cursorField = "page_token", budget = { calls: 0 }) {
  const items: Arguments[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    if (++budget.calls > 100) precheck("目录过大，无法在本次完整核对，请选择更小的明确子目录");
    const data = await callApi(token, queryPath(path, { ...params, page_token: cursor }));
    if (!Array.isArray(data[field]) || typeof data.has_more !== "boolean") precheck("飞书返回的列表或分页状态不完整");
    items.push(...(data[field] as unknown[]).map(obj));
    if (items.length > 500) precheck("单层项目超过 500 个，请分目录处理");
    if (!data.has_more) return items;
    const next = data[cursorField];
    if (typeof next !== "string" || !next || next.length > 4096 || cursors.has(next)) precheck("飞书分页游标缺失或重复");
    cursors.add(next as string); cursor = next as string;
  }
  return precheck("分页超过本次完整核对上限");
}

async function folderMeta(token: string, id: string) {
  const data = await callApi(token, "/drive/v1/metas/batch_query?user_id_type=open_id", { request_docs: [{ doc_token: id, doc_type: "folder" }], with_url: true });
  const matches = Array.isArray(data.metas) ? data.metas.map(obj).filter(item => item.doc_token === id && item.doc_type === "folder") : [];
  if (matches.length !== 1 || typeof matches[0].title !== "string" || (Array.isArray(data.failed_list) && data.failed_list.some(item => obj(item).token === id))) precheck("无法核对文件夹身份和名称");
  const m = matches[0];
  return { folder_token: id, name: m.title as string, owner_id: m.owner_id ?? null, latest_modify_time: m.latest_modify_time === undefined ? null : String(m.latest_modify_time) };
}

async function inspectFolder(token: string, input: unknown) {
  const id = folderToken(input);
  const root = await callApi(token, "/drive/explorer/v2/root_folder/meta");
  if (typeof root.token !== "string" || !root.token) precheck("无法核对个人根目录");
  if (id === root.token) throw new AppError("invalid_input", "不允许删除整个个人云空间根目录，请指定具体文件夹。");
  const meta = await folderMeta(token, id), entries: Arguments[] = [], seen = new Set([id]), budget = { calls: 0 };
  const queue = [{ id, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    if (i >= 50 || parent.depth > 20) precheck("目录层级或文件夹数量超过本次核对上限，请分目录处理");
    const files = await pages(token, "/drive/v1/files", { folder_token: parent.id, page_size: 200 }, "files", "next_page_token", budget);
    for (const f of files) {
      if (typeof f.token !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(f.token) || typeof f.name !== "string" || typeof f.type !== "string" || !f.type || (f.parent_token !== undefined && f.parent_token !== parent.id) || seen.has(f.token)) precheck("目录包含缺失、重复或不匹配的项目");
      const child = f.token as string; seen.add(child);
      entries.push({ token: child, name: f.name, type: f.type, parent_token: parent.id, modified_time: f.modified_time ?? null, owner_id: f.owner_id ?? null });
      if (entries.length > 500) precheck("目录项目超过 500 个，请分目录处理");
      // A shortcut is an entry, never a traversal into its origin.
      if (f.type === "folder") queue.push({ id: child, depth: parent.depth + 1 });
    }
  }
  compare(canonical(meta), canonical(await folderMeta(token, id)));
  entries.sort((a, b) => String(a.token).localeCompare(String(b.token)));
  return { ...meta, entries, descendant_count: entries.length, complete: true, snapshot_hash: await sha256(canonical({ meta, entries })), note: "范围包含文件夹的全部可见后代；快捷方式只计入口，不跟随源文件。哈希核对目录及元数据，飞书删除接口不提供原子条件锁。" };
}

function wikiIdentity(node: Arguments) {
  if (typeof node.node_token !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(node.node_token) || typeof node.space_id !== "string" || !/^\d{8,30}$/.test(node.space_id) || typeof node.title !== "string" || !["origin", "shortcut"].includes(String(node.node_type)) || typeof node.has_child !== "boolean" || typeof node.obj_token !== "string" || typeof node.obj_type !== "string") precheck("知识节点身份或子节点状态不完整");
  return { node_token: node.node_token as string, space_id: node.space_id as string, title: node.title as string, node_type: node.node_type, obj_token: node.obj_token, obj_type: node.obj_type, parent_node_token: node.parent_node_token ?? "", has_child: node.has_child, obj_edit_time: node.obj_edit_time ?? null, origin_node_token: node.origin_node_token ?? null, origin_space_id: node.origin_space_id ?? null };
}

async function inspectWiki(token: string, input: unknown, includeChildren: boolean) {
  const id = resourceToken(input, ["wiki"]);
  const get = async () => wikiIdentity(obj((await callApi(token, queryPath("/wiki/v2/spaces/node_by_token", { token: id }))).node));
  const node = await get();
  // node_by_token accepts doc tokens too; reject that ambiguity for destructive use.
  if (node.node_token !== id) precheck("输入不是准确的知识节点 token，请使用原始 /wiki/ 链接");
  const entries: ReturnType<typeof wikiIdentity>[] = [], seen = new Set([id]), budget = { calls: 0 }, queue = [{ node, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    if (i >= 50 || parent.depth > 20) precheck("知识库子树过大，请选择更小的明确子节点");
    if (parent.node.node_type === "shortcut") {
      if (parent.node.has_child) precheck("知识库快捷方式返回异常子节点状态");
      continue;
    }
    const children = await pages(token, `/wiki/v2/spaces/${node.space_id}/nodes`, { parent_node_token: parent.node.node_token, page_size: 50 }, "items", "page_token", budget);
    if ((children.length > 0) !== parent.node.has_child) precheck("子节点状态在读取期间变化或目录不完整");
    for (const raw of children) {
      const child = wikiIdentity(raw);
      if (child.space_id !== node.space_id || child.parent_node_token !== parent.node.node_token || seen.has(child.node_token)) precheck("知识库目录包含重复、跨空间或父节点不匹配的项目");
      seen.add(child.node_token); entries.push(child);
      if (entries.length > 500) precheck("知识节点超过 500 个，请分子树处理");
      if (includeChildren && child.has_child) queue.push({ node: child, depth: parent.depth + 1 });
    }
  }
  compare(canonical(node), canonical(await get()));
  entries.sort((a, b) => a.node_token.localeCompare(b.node_token));
  const snapshot = { node, include_children: includeChildren, entries };
  return { ...snapshot, complete: true, affected_child_count: entries.length, children_action: includeChildren ? "delete_subtree" : "lift_direct_children_to_parent", snapshot_hash: await sha256(canonical(snapshot)), note: "仅删除这个知识节点；快捷方式不跟随源节点。核对后提交仍可能遇到并发变化或飞书删除审批。" };
}

function deletionReceipt(result: Arguments, identity: Arguments, scenario: string) {
  if (result.task_id !== undefined && result.task_id !== null && result.task_id !== "") {
    if (typeof result.task_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(result.task_id)) throw new AppError("delete_not_confirmed", "飞书删除回执中的任务 ID 无效，请核对目标状态。", 502);
    return { ...identity, deleted: false, state: "pending", task_id: result.task_id, next_tool: "feishu_get_delete_task", next_arguments: { scenario, task_id: result.task_id } };
  }
  return { ...identity, deleted: true, state: "deleted" };
}

export const CONTAINER_DELETION_INTEGRATIONS = [
  integration("feishu_inspect_folder", "核对待删除文件夹", "读取准确文件夹及其后代目录，返回名称和 snapshot_hash。最多 500 个项目、50 个文件夹；读取不完整不会产生可删除快照。不会跟随快捷方式。", { folder: folderField }, ["folder"], ["drive:drive:readonly", DRIVE_METADATA_SCOPE], async (_e, _u, a, token) => inspectFolder(token, a.folder)),
  integration("feishu_delete_folder", "删除云空间文件夹", "仅删除用户明确指定的文件夹。先用 feishu_inspect_folder 完整核对名称和 snapshot_hash。delete_contents=true 会连同全部内容删除，须已获用户对该范围的授权；false 只允许空文件夹。异步删除必须继续查询任务，不能把 pending 当完成。", { folder: folderField, expected_name: stringField("核对返回的准确文件夹名称", 500), expected_snapshot_hash: hashField, delete_contents: { ...boolField, description: "是否明确要求连同文件夹内全部内容删除；必须填写" } }, ["folder", "expected_name", "expected_snapshot_hash", "delete_contents"], ["drive:drive:readonly", DRIVE_METADATA_SCOPE, "space:document:delete"], async (_e, _u, a, token) => {
    const current = await inspectFolder(token, a.folder);
    compare(current.name, a.expected_name); compare(current.snapshot_hash, a.expected_snapshot_hash);
    if (!a.delete_contents && current.descendant_count) throw new AppError("invalid_input", "文件夹非空。只有用户明确要求连同内容删除时才可使用 delete_contents=true。未执行删除。");
    const result = await callApi(token, queryPath(`/drive/v1/files/${current.folder_token}`, { type: "folder", async: true }), undefined, "DELETE");
    return deletionReceipt(result, { folder_token: current.folder_token, name: current.name, descendant_count: current.descendant_count, destination: "recycle_bin" }, "drive");
  }, true, true),
  integration("feishu_inspect_wiki_node", "核对待删除知识库节点", "核对节点和明确的子节点处理范围，返回 snapshot_hash。include_children=true 完整读取后代；false 读取将被提升到上一级的直接子节点。不会把底层文档 token 或快捷方式源节点当成删除目标。", wikiFields, ["wiki", "include_children"], ["wiki:node:retrieve"], async (_e, _u, a, token) => inspectWiki(token, a.wiki, a.include_children as boolean)),
  integration("feishu_delete_wiki_node", "删除知识库节点", "按用户明确要求删除知识库节点。先用 feishu_inspect_wiki_node 核对标题、snapshot_hash 和 include_children：true 连同全部后代删除，false 保留并提升直接子节点。快捷方式只删除入口。遵守飞书删除审批；异步受理后使用查询工具核对。", { ...wikiFields, expected_title: stringField("节点准确标题", 500), expected_snapshot_hash: hashField }, ["wiki", "include_children", "expected_title", "expected_snapshot_hash"], ["wiki:node:retrieve", "wiki:node:create"], async (_e, _u, a, token) => {
    const current = await inspectWiki(token, a.wiki, a.include_children as boolean);
    compare(current.node.title, a.expected_title); compare(current.snapshot_hash, a.expected_snapshot_hash);
    let result: Arguments;
    try { result = await callApi(token, `/wiki/v2/spaces/${current.node.space_id}/nodes/${current.node.node_token}`, { obj_type: "wiki", include_children: a.include_children }, "DELETE"); }
    catch (error) {
      if (error instanceof AppError && error.details?.provider_code === 131011) error.message = "该知识节点开启了删除审批，请先在飞书知识库申请审批；未绕过审批。";
      if (error instanceof AppError && error.details?.provider_code === 131003) error.message = "飞书拒绝一次删除过大的子树。请重新明确更小的删除范围，不会自动改为保留子节点或改删其他目标。";
      throw error;
    }
    return deletionReceipt(result, { node: current.node, include_children: a.include_children, affected_child_count: current.affected_child_count, children_action: current.children_action }, "wiki_node");
  }, true, true),
  integration("feishu_get_delete_task", "查询异步删除结果", "只查询删除工具返回的 task_id。scenario=drive 查询文件/文件夹任务，wiki_node 查询知识节点删除任务。仅 provider_status=success 才报告 deleted=true；失败或未知不自动重试删除。", { scenario: enumField(["drive", "wiki_node"]), task_id: { ...stringField("删除回执中的 task_id", 200), pattern: "^[A-Za-z0-9_-]{1,200}$" } }, ["scenario", "task_id"], [], async (e, u, a) => {
    const token = await accessToken(e, u, a.scenario === "drive" ? ["drive:drive:readonly"] : ["wiki:space:read"]);
    const data = await callApi(token, a.scenario === "drive" ? queryPath("/drive/v1/files/task_check", { task_id: a.task_id as string }) : queryPath(`/wiki/v2/tasks/${a.task_id}`, { task_type: "delete_node" }));
    const task = obj(data.task);
    if (a.scenario === "wiki_node" && task.task_id !== undefined && task.task_id !== a.task_id) throw new AppError("resource_precheck_failed", "异步任务返回的 ID 与查询不一致，无法确认删除状态。", 502);
    const raw = a.scenario === "drive" ? data.status : obj(task.simple_task_result).status;
    const status = typeof raw === "string" ? raw.trim().toLowerCase() : "unknown";
    const state = status === "success" ? "deleted" : ["fail", "failure", "failed"].includes(status) ? "failed" : ["process", "processing"].includes(status) ? "pending" : "unknown";
    return { scenario: a.scenario, task_id: a.task_id, state, deleted: state === "deleted", terminal: state === "deleted" || state === "failed", provider_status: raw ?? null, note: state === "failed" ? "异步任务失败，可能已有部分变化；请核对目标后再决定后续操作。" : "这是任务状态查询，不提交任何新的删除。" };
  }),
];
