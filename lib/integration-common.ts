import { AppError } from "./core";
import { accessToken, apiWithToken, type Runtime } from "./feishu";
import { tool, writeOnce, type Arguments, type Schema } from "./workspace-common";

export const enumField = (values: string[], description?: string): Schema => ({ type: "string", enum: values, ...(description ? { description } : {}) });
export const boolField: Schema = { type: "boolean" };
export const jsonObject: Schema = { type: "object", additionalProperties: true, maxProperties: 100 };
export const objectArray = (properties: Record<string, Schema>, required: string[], maximum = 100): Schema => ({ type: "array", minItems: 1, maxItems: maximum, items: { type: "object", properties, required, additionalProperties: false } });
export const obj = (value: unknown): Arguments => value && typeof value === "object" && !Array.isArray(value) ? value as Arguments : {};
export type Integration = { definition: ReturnType<typeof tool>; scopes: string[]; run: (env: Runtime, user: string, args: Arguments, token: string) => Promise<unknown> };
export function integration(name: string, title: string, description: string, properties: Record<string, Schema>, required: string[], scopes: string[], run: Integration["run"], write = false, destructive = false): Integration {
  return { definition: tool(name, title, description, properties, required, write, destructive), scopes, run };
}

// Validate nested arguments before obtaining a token or performing a mutation.
// Provider-specific constraints are checked by the operation itself.
export function validate(value: unknown, schema: Schema, at = "参数", depth = 0): void {
  if (depth > 16) throw new AppError("invalid_input", "参数嵌套过深。");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && !types.includes(kind) && !(kind === "number" && types.includes("integer") && Number.isInteger(value))) throw new AppError("invalid_input", `${at}类型无效。`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new AppError("invalid_input", `${at}不在允许的选项中。`);
  if (typeof value === "string") {
    if (value.includes("\0") || value.length < Number(schema.minLength ?? 0) || value.length > Number(schema.maxLength ?? 100000) || (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))) throw new AppError("invalid_input", `${at}格式或长度无效。`);
  }
  if (typeof value === "number" && (!Number.isFinite(value) || value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity))) throw new AppError("invalid_input", `${at}超出允许范围。`);
  if (Array.isArray(value)) {
    if (value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? 1000)) throw new AppError("invalid_input", `${at}条数无效。`);
    for (const item of value) if (schema.items) validate(item, schema.items as Schema, at + "[]", depth + 1);
  } else if (kind === "object") {
    const input = value as Arguments, fields = obj(schema.properties);
    if (Object.keys(input).length > Number(schema.maxProperties ?? 200) || Object.keys(input).length < Number(schema.minProperties ?? 0)) throw new AppError("invalid_input", `${at}字段数量无效。`);
    for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) if (input[key] === undefined) throw new AppError("invalid_input", `${at}缺少 ${key}。`);
    for (const [key, child] of Object.entries(input)) {
      if (fields[key]) validate(child, fields[key] as Schema, at + "." + key, depth + 1);
      else if (schema.additionalProperties === false) throw new AppError("invalid_input", `${at}包含不支持的字段 ${key}。`);
      else if (JSON.stringify(child).length > 50000 || ["__proto__", "constructor", "prototype"].includes(key)) throw new AppError("invalid_input", `${at}字段内容无效或过长。`);
    }
  }
}
export async function runIntegration(spec: Integration, env: Runtime, user: string, args: Arguments): Promise<unknown> {
  validate(args, spec.definition.inputSchema);
  if (!spec.definition.annotations.readOnlyHint) return writeOnce(env, user, spec.definition.name, args, spec.scopes, token => spec.run(env, user, args, token));
  return spec.run(env, user, args, await accessToken(env, user, spec.scopes));
}
export const queryPath = (path: string, values: Record<string, string | number | boolean | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  return path + (query.size ? `?${query}` : "");
};
export const callApi = async (token: string, path: string, body?: unknown, method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") => obj(await apiWithToken(token, path, body, method));
