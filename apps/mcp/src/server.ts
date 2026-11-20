// The MCP server: curated tools + one tool per API operation, over whatever transport main.ts
// (stdio) or a test (in-memory) connects.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { StudioClient, type StudioClientOptions, StudioError } from "./client.ts";
import { CURATED_TOOLS, type CuratedTool } from "./curated.ts";
import { type CallLog, fileLog } from "./log.ts";
import { ArgumentError, NEEDS_CONFIRM, type RunContext, runOperation } from "./operations.ts";
import { type ToolResult, textResult } from "./output.ts";
import { loadCachedSpec, type OpenApiDoc, type OperationTool, toolsFromSpec } from "./spec.ts";

export const SERVER_NAME = "studio";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "Studio (Burak'ın sosyal medya içerik stüdyosu) bu Mac'te çalışır; bu sunucu onun yerel API'sini",
  "sahip olarak kullanır. Önce studio_status'u çağırın. Sohbet ajanıyla çalışmak için studio_chat,",
  "kartlara cevap için studio_answer, işleri beklemek için studio_wait_job kullanın.",
  "Tehlikeli işlemler (silme, yayınlama / zamanlama, hesap bağlantısını kesme, anahtar / cihaz /",
  "bütçe değişikliği, ücretli ya da toplu üretim, izin kartını onaylama) confirm: true ister:",
  "bunu yalnızca sahip açıkça istediyse verin.",
  "(Studio runs on this Mac; this server drives its local API as the owner. Dangerous tools need",
  "confirm: true, only when the owner explicitly asked.)",
].join(" ");

export interface StudioServerOptions extends StudioClientOptions {
  /** OpenAPI document to use instead of fetching it (tests). */
  spec?: OpenApiDoc;
  /** Cached copy used when the API is not reachable (default apps/mcp/openapi.json). */
  cachedSpecPath?: string;
  log?: CallLog;
  homeDir?: string;
  tmpDir?: string;
  /**
   * `all` (default): curated tools + one per API operation. `curated`: only the studio_* tools
   * (smaller tool list). Default from env STUDIO_MCP_TOOLS.
   */
  toolset?: "all" | "curated";
}

type SpecSource = "live" | "cached" | "given";

const LIVE_RETRY_MS = 30_000;

export class StudioMcp {
  readonly client: StudioClient;
  readonly server: Server;
  private readonly log: CallLog;
  private operations: OperationTool[] = [];
  private byName = new Map<string, OperationTool>();
  private source: SpecSource | null = null;
  private lastLiveTry = 0;
  private loading: Promise<void> | null = null;

  private readonly options: StudioServerOptions;

  constructor(options: StudioServerOptions = {}) {
    this.options = options;
    this.client = new StudioClient(options);
    this.log = options.log ?? fileLog(this.client.stateDir);
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.ensureSpec();
      return { tools: this.listTools() };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      await this.ensureSpec();
      const token = request.params._meta?.progressToken;
      const ctx: RunContext = {
        client: this.client,
        signal: extra.signal,
        ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
        ...(this.options.tmpDir ? { tmpDir: this.options.tmpDir } : {}),
        ...(token !== undefined
          ? {
              progress: async (progress: number, total?: number, message?: string) => {
                await extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress,
                      ...(total !== undefined ? { total } : {}),
                      ...(message ? { message: this.client.scrub(message) } : {}),
                    },
                  })
                  .catch(() => {});
              },
            }
          : {}),
      };
      return this.call(request.params.name, request.params.arguments ?? {}, ctx);
    });
  }

  /** Loads the spec once: the live one when Studio answers, else the cached copy. */
  async ensureSpec(): Promise<void> {
    if (this.options.spec) {
      if (!this.source) this.setSpec(this.options.spec, "given");
      return;
    }
    const retry = this.source === "cached" && Date.now() - this.lastLiveTry > LIVE_RETRY_MS;
    if (this.source && !retry) return;
    this.loading ??= this.loadSpec().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  private async loadSpec(): Promise<void> {
    this.lastLiveTry = Date.now();
    try {
      const res = await this.client.request({
        method: "GET",
        path: "/api/openapi.json",
        timeoutMs: 3_000,
      });
      const doc = res.json as OpenApiDoc | undefined;
      if (res.status === 200 && doc && typeof doc === "object" && doc.paths) {
        const changed = this.source !== null;
        this.setSpec(doc, "live");
        this.log.event(`spec=live tools=${this.operations.length}`);
        if (changed) await this.server.sendToolListChanged().catch(() => {});
        return;
      }
    } catch {
      // Studio not running (or no secret yet): use the cached copy.
    }
    if (this.source === null) {
      this.setSpec(loadCachedSpec(this.options.cachedSpecPath), "cached");
      this.log.event(`spec=cached tools=${this.operations.length}`);
    }
  }

  private setSpec(doc: OpenApiDoc, source: SpecSource): void {
    const curated = new Set(CURATED_TOOLS.map((t) => t.name));
    const toolset =
      this.options.toolset ?? (process.env.STUDIO_MCP_TOOLS === "curated" ? "curated" : "all");
    this.operations =
      toolset === "curated" ? [] : toolsFromSpec(doc).filter((t) => !curated.has(t.name));
    this.byName = new Map(this.operations.map((t) => [t.name, t]));
    this.source = source;
  }

  get specSource(): SpecSource | null {
    return this.source;
  }

  get operationTools(): readonly OperationTool[] {
    return this.operations;
  }

  listTools(): Tool[] {
    const curated: Tool[] = CURATED_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
    const generated: Tool[] = this.operations.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: t.method === "GET",
        destructiveHint: t.dangerous,
        idempotentHint: t.method === "GET" || t.method === "PUT" || t.method === "DELETE",
        openWorldHint: false,
      },
    }));
    return [...curated, ...generated];
  }

  async call(name: string, rawArgs: Record<string, unknown>, ctx: RunContext): Promise<ToolResult> {
    const started = performance.now();
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const curated: CuratedTool | undefined = CURATED_TOOLS.find((t) => t.name === name);
    const operation = curated ? undefined : this.byName.get(name);
    if (!curated && !operation) {
      this.log.call(name, "refused", performance.now() - started);
      return textResult(`Bilinmeyen araç (unknown tool): ${name}`, true);
    }
    try {
      const result = curated
        ? await curated.run(args, ctx)
        : await runOperation(operation as OperationTool, args, ctx);
      const status = (result as unknown as Record<symbol, unknown>)[NEEDS_CONFIRM]
        ? "needs_confirm"
        : result.isError
          ? "error"
          : "ok";
      this.log.call(name, status, performance.now() - started);
      return result;
    } catch (error) {
      let message: string;
      let status: "error" | "refused" = "error";
      if (error instanceof StudioError) {
        message = error.message;
        if (error.code === "refused") status = "refused";
      } else if (error instanceof ArgumentError) {
        message = `Geçersiz argüman (invalid argument): ${error.message}`;
        status = "refused";
      } else {
        message = `Beklenmeyen hata (unexpected error): ${error instanceof Error ? error.message : String(error)}`;
      }
      this.log.call(name, status, performance.now() - started);
      return textResult(this.client.scrub(message), true);
    }
  }
}

export function createStudioMcp(options: StudioServerOptions = {}): StudioMcp {
  return new StudioMcp(options);
}
