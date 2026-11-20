// Running a generated (OpenAPI) tool: confirm gate, URL, query, JSON or multipart body.
import type { StudioClient } from "./client.ts";
import { FileRefused, readUploadFile } from "./files.ts";
import { responseResult, type ToolResult, textResult } from "./output.ts";
import { confirmRefusal, dangerFor } from "./safety.ts";
import type { OperationTool } from "./spec.ts";

export interface RunContext {
  client: StudioClient;
  /** Home folder uploads must come from (tests point it elsewhere). */
  homeDir?: string;
  /** Where binary responses are saved (default: the OS temp folder). */
  tmpDir?: string;
  signal?: AbortSignal;
  progress?: (progress: number, total?: number, message?: string) => Promise<void>;
}

export class ArgumentError extends Error {}

/** Result marker so the server can log `needs_confirm` separately. */
export const NEEDS_CONFIRM = Symbol("needs_confirm");

export function needsConfirm(toolName: string, reason: string): ToolResult {
  const result = textResult(confirmRefusal(toolName, reason), true);
  Object.defineProperty(result, NEEDS_CONFIRM, { value: true, enumerable: false });
  return result;
}

export function fillPath(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = args[name];
    if (value === undefined || value === null || String(value) === "") {
      throw new ArgumentError(`eksik yol parametresi (missing path parameter): ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** Builds the multipart body; file fields come from `<field>_path`. */
export function buildForm(
  tool: Pick<OperationTool, "fileFields">,
  body: Record<string, unknown>,
  homeDir?: string,
): FormData {
  const form = new FormData();
  for (const field of tool.fileFields) {
    const path = body[`${field}_path`];
    if (typeof path !== "string") {
      throw new ArgumentError(`${field}_path gerekli (a local file path is required)`);
    }
    const file = readUploadFile(path, homeDir ? { home: homeDir } : {});
    form.append(field, new Blob([Buffer.from(file.bytes)], { type: file.mimeType }), file.name);
  }
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (tool.fileFields.some((f) => key === `${f}_path`)) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return form;
}

export async function runOperation(
  tool: OperationTool,
  args: Record<string, unknown>,
  ctx: RunContext,
): Promise<ToolResult> {
  const danger = dangerFor(tool.method, tool.path, args);
  if (danger && args.confirm !== true) return needsConfirm(tool.name, danger.reason);

  const path = fillPath(tool.path, args);
  const query: Record<string, unknown> = {};
  for (const name of tool.queryParams) {
    if (args[name] !== undefined && args[name] !== null) query[name] = args[name];
  }
  let json: unknown;
  let form: FormData | undefined;
  if (tool.body === "json" && args.body !== undefined) {
    json = args.body;
  } else if (tool.body === "multipart") {
    const body = args.body;
    if (!body || typeof body !== "object") throw new ArgumentError("body gerekli (body required)");
    try {
      form = buildForm(tool, body as Record<string, unknown>, ctx.homeDir);
    } catch (error) {
      if (error instanceof FileRefused)
        return textResult(`Dosya reddedildi: ${error.message}`, true);
      throw error;
    }
  }
  const res = await ctx.client.request({ method: tool.method, path, query, json, form });
  const offset = typeof args.response_offset === "number" ? args.response_offset : 0;
  return responseResult(res, (t) => ctx.client.scrub(t), {
    offset,
    hint: tool.name,
    ...(ctx.tmpDir ? { tmpDir: ctx.tmpDir } : {}),
  });
}
