import { AppError } from "./core";
import { type Runtime } from "./feishu";
import { type Arguments } from "./workspace-common";
import { runIntegration } from "./integration-common";
import { COLLABORATION_INTEGRATIONS } from "./collaboration-tools";
import { TABLE_INTEGRATIONS } from "./table-extensions";
import { FILE_INTEGRATIONS } from "./file-transfers";
import { PRODUCTIVITY_INTEGRATIONS } from "./productivity-tools";
import { WATCH_INTEGRATIONS } from "./watches";
import { DELETION_INTEGRATIONS } from "./deletion-tools";
import { CONTAINER_DELETION_INTEGRATIONS } from "./container-deletion";
import { CONTENT_DELETION_INTEGRATIONS } from "./content-deletion";
export const INTEGRATIONS = [...COLLABORATION_INTEGRATIONS, ...TABLE_INTEGRATIONS, ...FILE_INTEGRATIONS, ...PRODUCTIVITY_INTEGRATIONS, ...WATCH_INTEGRATIONS, ...DELETION_INTEGRATIONS, ...CONTAINER_DELETION_INTEGRATIONS, ...CONTENT_DELETION_INTEGRATIONS];
export const EXTENSION_TOOLS = INTEGRATIONS.map(spec => spec.definition);
export function runExtensionTool(env: Runtime, user: string, name: string, args: Arguments) {
  const spec = INTEGRATIONS.find(item => item.definition.name === name);
  if (!spec) throw new AppError("unknown_tool", "未知扩展工具。");
  return runIntegration(spec, env, user, args);
}
