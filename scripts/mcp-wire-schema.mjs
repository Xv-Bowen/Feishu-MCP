import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Validate raw responses against the upstream schemas, before a client strips
// wire-only fields. The fixtures are pinned so CI needs no network access.
const validators = new Map();
for (const version of ["2026-07-28", "2025-11-25"]) {
  const schema = JSON.parse(readFileSync(new URL(`./fixtures/mcp-${version}-schema.json`, import.meta.url)));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema, version);
  for (const name of ["JSONRPCResponse", "Result", "CallToolResult", "ListToolsResult", version === "2026-07-28" ? "DiscoverResult" : "InitializeResult"]) {
    validators.set(`${version}/${name}`, ajv.getSchema(`${version}#/$defs/${name}`));
  }
}

function validate(value, name, version) {
  const check = validators.get(`${version}/${name}`);
  assert.ok(check, `Missing official schema ${version}/${name}`);
  assert.ok(check(value), `${version}/${name}: ${JSON.stringify(check.errors)}`);
}

export function assertMcpWireResponse(message, method) {
  validate(message, "JSONRPCResponse", "2026-07-28");
  if (!message.result) return;
  const name = { "tools/call": "CallToolResult", "tools/list": "ListToolsResult", "server/discover": "DiscoverResult" }[method] || "Result";
  validate(message.result, name, "2026-07-28");
  // Every implemented result finishes this request, including provider errors.
  assert.equal(message.result.resultType, "complete");
  assert.ok(message.result._meta?.["io.modelcontextprotocol/serverInfo"]?.version);
  if (method !== "server/discover") {
    validate(message, "JSONRPCResponse", "2025-11-25");
    validate(message.result, method === "initialize" ? "InitializeResult" : name, "2025-11-25");
  }
}
