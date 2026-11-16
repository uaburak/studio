/**
 * The CLI's `stream-json` lines of a tool-using agent turn, as chat events
 * (after Wecra, DesignerV2 src/main/agents/providers/claudeCode.ts `parse`):
 *
 * - `system/init`             -> `session` (session id, model, MCP server status)
 * - `stream_event` text_delta -> `text` (sets `streamed`, so the full assistant message that
 *                                follows is not repeated); `content_block_start` tool_use ->
 *                                `tool` running (as soon as the model starts the call)
 * - `assistant`               -> text not already streamed; tool_use -> `tool` running (with args)
 * - `user` tool_result        -> `tool` done / error with a one-line summary
 * - `rate_limit_event`        -> `limits`
 * - `result`                  -> `result` (usage, error flag, text)
 */
import type { RateLimitInfo } from "./limits.ts";

export type AgentStreamEvent =
  | {
      type: "session";
      id: string;
      model?: string;
      cliVersion?: string;
      /** Our MCP server's status when it is not `connected`. */
      mcpProblem?: string;
    }
  | { type: "text"; delta: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: "running" | "done" | "error";
      args?: unknown;
      summary?: string;
    }
  | { type: "limits"; info: RateLimitInfo }
  | {
      type: "result";
      isError: boolean;
      text: string;
      sessionId?: string;
      subtype?: string;
      usage?: Record<string, unknown>;
    };

export interface StreamParseState {
  /** Text of the current message already streamed as deltas. */
  streamed: boolean;
  /** tool_use id -> short name. */
  tools: Map<string, string>;
  /** Tool ids whose `running` event went out with arguments. */
  argsSent: Set<string>;
}

export const newStreamParseState = (): StreamParseState => ({
  streamed: false,
  tools: new Map(),
  argsSent: new Set(),
});

/** `mcp__studio__propose_plan` -> `propose_plan`. */
export function shortToolName(name: unknown, server = "studio"): string {
  const s = String(name ?? "");
  const prefix = `mcp__${server}__`;
  if (s.startsWith(prefix)) return s.slice(prefix.length);
  return s.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}

/** A tool result's first text line (MCP content blocks or a string), for the step row. */
export function summarizeToolResult(content: unknown): string | undefined {
  const first = Array.isArray(content)
    ? (content as { type?: string; text?: string }[]).find((c) => c?.type === "text")?.text
    : typeof content === "string"
      ? content
      : undefined;
  if (!first) return undefined;
  const line = first.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 140) || undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseStreamLine(
  line: Record<string, unknown>,
  state: StreamParseState,
  server = "studio",
): AgentStreamEvent[] {
  const out: AgentStreamEvent[] = [];
  switch (line.type) {
    case "system": {
      if (line.subtype !== "init") break;
      const id = str(line.session_id);
      if (!id) break;
      const servers = Array.isArray(line.mcp_servers)
        ? (line.mcp_servers as { name?: string; status?: string }[])
        : [];
      const ours = servers.find((s) => s.name === server);
      out.push({
        type: "session",
        id,
        ...(str(line.model) ? { model: str(line.model) } : {}),
        ...(str(line.claude_code_version) ? { cliVersion: str(line.claude_code_version) } : {}),
        ...(ours && ours.status !== "connected"
          ? { mcpProblem: String(ours.status ?? "unknown") }
          : {}),
      });
      break;
    }
    case "stream_event": {
      const ev = line.event as
        | {
            type?: string;
            delta?: { type?: string; text?: string };
            content_block?: { type?: string; id?: string; name?: string };
          }
        | undefined;
      if (ev?.type === "message_start") {
        state.streamed = false;
      } else if (
        ev?.type === "content_block_delta" &&
        ev.delta?.type === "text_delta" &&
        ev.delta.text
      ) {
        state.streamed = true;
        out.push({ type: "text", delta: ev.delta.text });
      } else if (
        ev?.type === "content_block_start" &&
        ev.content_block?.type === "tool_use" &&
        ev.content_block.id
      ) {
        const id = ev.content_block.id;
        if (!state.tools.has(id)) {
          const name = shortToolName(ev.content_block.name, server);
          state.tools.set(id, name);
          out.push({ type: "tool", id, name, state: "running" });
        }
      }
      break;
    }
    case "assistant": {
      const content = ((line.message as { content?: unknown[] } | undefined)?.content ?? []) as {
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }[];
      for (const b of content) {
        // The CLI's own sign-in notice also comes as a message; the result says it once.
        if (b.type === "text" && b.text && !state.streamed && !/^Not logged in/i.test(b.text)) {
          out.push({ type: "text", delta: b.text });
        }
        if (b.type === "tool_use" && b.id && !state.argsSent.has(b.id)) {
          const name = state.tools.get(b.id) ?? shortToolName(b.name, server);
          state.tools.set(b.id, name);
          state.argsSent.add(b.id);
          out.push({ type: "tool", id: b.id, name, state: "running", args: b.input });
        }
      }
      state.streamed = false;
      break;
    }
    case "user": {
      const content = ((line.message as { content?: unknown[] } | undefined)?.content ?? []) as {
        type?: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }[];
      for (const b of content) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const summary = summarizeToolResult(b.content);
        out.push({
          type: "tool",
          id: b.tool_use_id,
          name: state.tools.get(b.tool_use_id) ?? "tool",
          state: b.is_error ? "error" : "done",
          ...(summary ? { summary } : {}),
        });
      }
      break;
    }
    case "rate_limit_event": {
      const info = line.rate_limit_info;
      if (info && typeof info === "object")
        out.push({ type: "limits", info: info as RateLimitInfo });
      break;
    }
    case "result": {
      const isError =
        line.is_error === true ||
        (typeof line.subtype === "string" && line.subtype.startsWith("error"));
      out.push({
        type: "result",
        isError,
        text: str(line.result),
        ...(str(line.session_id) ? { sessionId: str(line.session_id) } : {}),
        ...(typeof line.subtype === "string" ? { subtype: line.subtype } : {}),
        ...(line.usage && typeof line.usage === "object"
          ? { usage: line.usage as Record<string, unknown> }
          : {}),
      });
      break;
    }
  }
  return out;
}

/** A whole recorded output (NDJSON) through the parser (tests, debugging). */
export function parseRecordedStream(ndjson: string, server = "studio"): AgentStreamEvent[] {
  const state = newStreamParseState();
  const out: AgentStreamEvent[] = [];
  for (const raw of ndjson.split("\n")) {
    const s = raw.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.push(...parseStreamLine(JSON.parse(s) as Record<string, unknown>, state, server));
    } catch {
      // not JSON
    }
  }
  return out;
}
