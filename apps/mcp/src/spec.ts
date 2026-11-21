// OpenAPI → MCP tools: one tool per API operation the owner can call.
//
// Name: `operationId` in snake_case when the spec has one, else method + the path's fixed segments
// (`/api` dropped) + `by_<param>` when the path ends in a parameter:
//   GET  /api/brands/{id}                       → get_brands_by_id
//   POST /api/contents/{id}/versions/{v}/restore → post_contents_versions_restore
// Input: path parameters and query parameters as top-level properties, the JSON body as `body`
// (`$ref`s resolved inline, depth-limited), multipart file fields as `<field>_path` inside `body`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HttpMethod } from "./client.ts";
import { possibleDanger } from "./safety.ts";

export const CACHED_SPEC_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));

export type JsonSchema = Record<string, unknown>;

export interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface OperationTool {
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  /** OpenAPI path template, e.g. `/api/brands/{id}`. */
  path: string;
  tag: string;
  pathParams: string[];
  queryParams: string[];
  body: "json" | "multipart" | null;
  /** Multipart fields that carry a file (sent from `<field>_path`). */
  fileFields: string[];
  dangerous: boolean;
  inputSchema: JsonSchema & { type: "object" };
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Longest tool name (Claude Code prefixes `mcp__studio__`; the whole name must stay ≤ 64). */
export const MAX_TOOL_NAME = 48;
/** Schema nesting kept in tool inputs (deeper parts accept any value). */
const MAX_SCHEMA_DEPTH = 8;

/** Arguments every generated tool may take besides the operation's own. */
export const RESERVED_ARGS = ["confirm", "response_offset"] as const;

export function loadCachedSpec(path = CACHED_SPEC_PATH): OpenApiDoc {
  return JSON.parse(readFileSync(path, "utf8")) as OpenApiDoc;
}

export function snakeCase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}

/** Operations the MCP server never exposes (worker-only, device-only or WebSocket). */
export function isExcluded(method: string, path: string): boolean {
  if (path.startsWith("/api/worker/")) return true;
  if (path === "/api/pairing/claim") return true;
  // The Mac app's own settings sync (it hands out queued secret values).
  if (path === "/api/host/settings/sync") return true;
  if (method === "GET" && path.endsWith("/stream")) return true;
  if (path.startsWith("/api/dev/")) return true;
  return false;
}

export function toolNameFor(
  method: string,
  path: string,
  operationId?: string,
  allParams = false,
): string {
  if (operationId) return snakeCase(operationId);
  const segments = path.split("/").filter((s) => s.length > 0 && s !== "api");
  const parts = [method.toLowerCase()];
  segments.forEach((s, i) => {
    const isParam = s.startsWith("{");
    if (!isParam) parts.push(s);
    else if (allParams || i === segments.length - 1) parts.push("by", s.slice(1, -1));
  });
  return snakeCase(parts.join("_"));
}

function shorten(name: string): string {
  if (name.length <= MAX_TOOL_NAME) return name;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const suffix = hash.toString(36).slice(0, 5);
  return `${name.slice(0, MAX_TOOL_NAME - suffix.length - 1).replace(/_+$/, "")}_${suffix}`;
}

/** Inlines `$ref`s (`#/components/schemas/X`); cycles and deep nesting become "any value". */
export function resolveSchema(
  schema: unknown,
  doc: OpenApiDoc,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const input = schema as JsonSchema;
  const ref = input.$ref;
  if (typeof ref === "string") {
    const name = ref.startsWith("#/components/schemas/")
      ? ref.slice("#/components/schemas/".length)
      : null;
    const target = name ? doc.components?.schemas?.[name] : undefined;
    if (!name || !target || seen.has(name) || depth >= MAX_SCHEMA_DEPTH) {
      return { description: `${name ?? ref} (iç içe şema kısaltıldı; nested schema omitted)` };
    }
    const { $ref: _ref, ...rest } = input;
    const resolved = resolveSchema(target, doc, depth + 1, new Set([...seen, name]));
    return Object.keys(rest).length > 0
      ? { ...resolved, ...resolveSchema(rest, doc, depth, seen) }
      : resolved;
  }
  if (depth >= MAX_SCHEMA_DEPTH) {
    return typeof input.description === "string" ? { description: input.description } : {};
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "$schema" || key === "example" || key === "examples" || key === "id") continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, JsonSchema> = {};
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        props[prop] = resolveSchema(sub, doc, depth + 1, seen);
      }
      out.properties = props;
    } else if (
      (key === "items" ||
        key === "additionalProperties" ||
        key === "not" ||
        key === "propertyNames") &&
      value &&
      typeof value === "object"
    ) {
      out[key] = resolveSchema(value, doc, depth + 1, seen);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((sub) => resolveSchema(sub, doc, depth + 1, seen));
    } else if (key === "prefixItems" && Array.isArray(value)) {
      out[key] = value.map((sub) => resolveSchema(sub, doc, depth + 1, seen));
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

function parametersOf(op: Record<string, unknown>, item: Record<string, unknown>): Parameter[] {
  const list = [
    ...((item.parameters as Parameter[] | undefined) ?? []),
    ...((op.parameters as Parameter[] | undefined) ?? []),
  ];
  const byKey = new Map<string, Parameter>();
  for (const p of list) if (p && typeof p.name === "string") byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

function paramSchema(p: Parameter, doc: OpenApiDoc): JsonSchema {
  const schema = resolveSchema(p.schema ?? { type: "string" }, doc);
  if (p.description && !schema.description) schema.description = p.description;
  return schema;
}

function isFileSchema(schema: JsonSchema): boolean {
  return schema.format === "binary" || schema.contentMediaType === "application/octet-stream";
}

/** Builds the tools of an OpenAPI document (sorted by path, then method). */
export function toolsFromSpec(doc: OpenApiDoc): OperationTool[] {
  const tools: OperationTool[] = [];
  const used = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method.toLowerCase()] as Record<string, unknown> | undefined;
      if (!op || isExcluded(method, path)) continue;
      const operationId = op.operationId as string | undefined;
      let name = shorten(toolNameFor(method, path, operationId));
      // Same fixed segments elsewhere (`/contents/repurpose` vs `/contents/{id}/repurpose`):
      // spell every parameter out.
      if (used.has(name)) name = shorten(toolNameFor(method, path, operationId, true));
      const base = name;
      for (let i = 2; used.has(name); i++) name = shorten(`${base}_${i}`);
      used.add(name);

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      for (const p of parametersOf(op, item)) {
        if (p.in === "path") {
          pathParams.push(p.name);
          properties[p.name] = paramSchema(p, doc);
          required.push(p.name);
        } else if (p.in === "query") {
          queryParams.push(p.name);
          properties[p.name] = paramSchema(p, doc);
          if (p.required) required.push(p.name);
        }
      }
      // Template parameters the spec forgot to declare.
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        const p = match[1] as string;
        if (!pathParams.includes(p)) {
          pathParams.push(p);
          properties[p] = { type: "string" };
          required.push(p);
        }
      }

      let body: OperationTool["body"] = null;
      const fileFields: string[] = [];
      const requestBody = op.requestBody as
        | { required?: boolean; content?: Record<string, { schema?: unknown }> }
        | undefined;
      const content = requestBody?.content ?? {};
      if (content["application/json"]) {
        body = "json";
        properties.body = resolveSchema(content["application/json"].schema ?? {}, doc);
        if (requestBody?.required) required.push("body");
      } else if (content["multipart/form-data"]) {
        body = "multipart";
        const form = resolveSchema(content["multipart/form-data"].schema ?? {}, doc);
        const formProps = (form.properties as Record<string, JsonSchema> | undefined) ?? {};
        const formRequired = new Set((form.required as string[] | undefined) ?? []);
        const outProps: Record<string, JsonSchema> = {};
        const outRequired: string[] = [];
        for (const [field, schema] of Object.entries(formProps)) {
          if (isFileSchema(schema)) {
            fileFields.push(field);
            outProps[`${field}_path`] = {
              type: "string",
              description: "Absolute path of a regular file inside your home folder.",
            };
            if (formRequired.has(field)) outRequired.push(`${field}_path`);
          } else {
            outProps[field] = schema;
            if (formRequired.has(field)) outRequired.push(field);
          }
        }
        properties.body = { type: "object", properties: outProps, required: outRequired };
        required.push("body");
      }

      const danger = possibleDanger(method, path);
      if (danger) {
        properties.confirm = {
          type: "boolean",
          description: "Dangerous: true only when the owner explicitly asked for it.",
        };
      }
      properties.response_offset = {
        type: "integer",
        minimum: 0,
        description: "Read a truncated response on from this offset.",
      };

      const summary = typeof op.summary === "string" ? op.summary : `${method} ${path}`;
      const lines = [summary];
      if (typeof op.description === "string" && op.description.trim()) {
        lines.push(op.description.trim());
      }
      lines.push(`${method} ${path}`);
      if (danger) {
        lines.push(
          `DANGEROUS (${danger.reason})${danger.when ? " for some arguments" : ""}: ` +
            "requires confirm: true, and only when the owner explicitly asked for it.",
        );
      }
      if (body === "multipart") {
        lines.push("File fields take a local path (`<field>_path`) inside the home folder.");
      }
      const tags = op.tags as string[] | undefined;
      tools.push({
        name,
        title: summary,
        description: lines.join("\n\n"),
        method,
        path,
        tag: tags?.[0] ?? "Other",
        pathParams,
        queryParams,
        body,
        fileFields,
        dangerous: danger !== null,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      });
    }
  }
  return tools;
}
