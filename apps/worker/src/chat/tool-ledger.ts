/**
 * Idempotency of the chat tools that create work or spend money (U7): `generate_post` (brief),
 * `generate_reel` (brief) and `generate_ai_image`. Each such call is written down per
 * conversation with a key of its meaningful arguments; the same call again within a few hours
 * (a turn continued with "devam et", the model repeating itself) returns the first call's result
 * instead of a second post / paid image. The model can still ask for a deliberate second run
 * (`repeat: true`).
 *
 * Kept as `<stateDir>/chat/<conversation>/tool-calls.json` next to the conversation's Claude
 * sessions, so it survives a worker restart.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LedgerEntry {
  key: string;
  tool: string;
  /** The tool call id that made it (for the logs). */
  callId: string | null;
  at: string;
  data: Record<string, unknown>;
}

/** Same arguments within this window count as the same call. */
export const TOOL_LEDGER_TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 200;

/** A stable key of a tool's meaningful arguments (key order and undefined values ignored). */
export function toolCallKey(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${tool}\n${canonical(args)}`)
    .digest("hex")
    .slice(0, 32);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export class ToolCallLedger {
  private cache: LedgerEntry[] | undefined;

  constructor(
    /** The JSON file; undefined keeps the ledger in memory (tests, no state dir). */
    private readonly file: string | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = TOOL_LEDGER_TTL_MS,
  ) {}

  /**
   * The earlier call with this key, when it is recent enough. (Tool call ids are not used: the
   * MCP JSON-RPC ids start again in every session, so they repeat across turns.)
   */
  async find(key: string): Promise<LedgerEntry | null> {
    const entries = await this.load();
    const cutoff = this.now().getTime() - this.ttlMs;
    return entries.find((e) => e.key === key && new Date(e.at).getTime() >= cutoff) ?? null;
  }

  async put(entry: Omit<LedgerEntry, "at">): Promise<void> {
    const cutoff = this.now().getTime() - this.ttlMs;
    const entries = (await this.load()).filter(
      (e) => e.key !== entry.key && new Date(e.at).getTime() >= cutoff,
    );
    entries.unshift({ ...entry, at: this.now().toISOString() });
    this.cache = entries.slice(0, MAX_ENTRIES);
    if (!this.file) return;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, entries: this.cache }), "utf8");
      await rename(tmp, this.file);
    } catch {
      // the in-memory ledger still protects this turn
    }
  }

  private async load(): Promise<LedgerEntry[]> {
    if (this.cache) return this.cache;
    if (!this.file) {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as { entries?: LedgerEntry[] };
      this.cache = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }
}
