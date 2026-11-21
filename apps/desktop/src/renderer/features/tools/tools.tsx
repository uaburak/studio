// The tools Studio uses on the Mac (contract tools.ts): Ayarlar → Gelişmiş → Araçlar, and the
// "<araç> gerekli · Kur" line a feature shows instead of a raw error. Status comes from the
// worker (presence `tools`, live during an install; `GET /api/tools` before the first frame);
// "Kur" / "Güncelle" / "Kaldır" start the worker's `tool.install` / `tool.uninstall` jobs through
// the API, so the iPhone and the chat use the very same path.
import { formatToolSize, type ToolId, type ToolStatus, toolManifest } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { Button, Spinner } from "../../components/ui/controls.tsx";
import { ApiContext, describeError } from "../../lib/api.ts";
import { useJobsSnapshot } from "../../state/studio.tsx";

export interface ToolsView {
  tools: ToolStatus[];
  online: boolean;
  /** null: the worker never reported. */
  find(id: ToolId): ToolStatus | null;
  install(id: ToolId, update?: boolean): Promise<void>;
  uninstall(id: ToolId): Promise<void>;
  refresh(): Promise<void>;
  error: string | null;
  busy: ToolId | null;
}

export function useTools(): ToolsView {
  // Outside the app's providers (a component on its own) there is simply nothing to show.
  const api = useContext(ApiContext);
  const { presence } = useJobsSnapshot();
  const fetched = useQuery({
    queryKey: ["tools"],
    queryFn: () => (api ? api.tools.list() : Promise.resolve(null)),
    enabled: api !== null,
    // Presence carries the live list; the query is the first paint and the fallback.
    staleTime: 30_000,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ToolId | null>(null);
  const tools = presence?.tools ?? fetched.data?.tools ?? [];
  const online = presence?.online ?? fetched.data?.online ?? false;
  const run = async (id: ToolId, fn: () => Promise<unknown>) => {
    if (!api) return;
    setError(null);
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      setError(`${toolManifest(id).label}: ${describeError(e)}`);
    } finally {
      setBusy(null);
    }
  };
  return {
    tools,
    online,
    find: (id) => tools.find((t) => t.id === id) ?? null,
    install: (id, update) =>
      run(id, () =>
        (api as NonNullable<typeof api>).tools.install(id, update ? { update: true } : {}),
      ),
    uninstall: (id) => run(id, () => (api as NonNullable<typeof api>).tools.uninstall(id)),
    refresh: async () => {
      if (!api) return;
      setError(null);
      try {
        await api.tools.refresh();
      } catch (e) {
        setError(describeError(e));
      }
      await fetched.refetch();
    },
    error,
    busy,
  };
}

const STATE_TEXT: Record<ToolStatus["state"], string> = {
  installed: "Kurulu",
  missing: "Kurulu değil",
  outdated: "Güncelleme var",
  installing: "Kuruluyor…",
  failed: "Kurulamadı",
};

function ProgressBar({ value }: { value: number | null }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1 w-full overflow-hidden rounded-full bg-field"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** One tool: status, version, source, size, and its buttons. */
export function ToolRow({ tool, view }: { tool: ToolStatus; view: ToolsView }) {
  const installing = tool.state === "installing";
  const pending = view.busy === tool.id;
  const canInstall =
    tool.installable && (tool.state === "missing" || tool.state === "failed") && view.online;
  const canUpdate =
    tool.location === "studio" &&
    tool.installable &&
    (tool.state === "outdated" || tool.state === "installed") &&
    view.online;
  const meta = [
    STATE_TEXT[tool.state],
    tool.version ? `sürüm ${tool.version}` : null,
    tool.location === "studio"
      ? "Studio'nun kopyası"
      : tool.location === "system"
        ? "Mac'te kurulu"
        : null,
    tool.state === "outdated" && tool.targetVersion ? `yenisi ${tool.targetVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-1 border-b border-hairline py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={`w-3 shrink-0 text-caption ${
            tool.state === "installed"
              ? "text-fg-3"
              : tool.state === "failed"
                ? "text-danger"
                : "text-accent-text"
          }`}
        >
          {tool.state === "installed" ? "●" : tool.state === "failed" ? "✕" : "○"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-fg">{tool.label}</span>
            {tool.optional && <span className="text-caption text-fg-3">isteğe bağlı</span>}
          </div>
          <div className="selectable text-footnote text-fg-2">{meta}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canInstall && (
            <Button
              variant="primary"
              size="sm"
              disabled={pending}
              icon={pending ? <Spinner size={12} /> : undefined}
              onClick={() => void view.install(tool.id)}
            >
              Kur
            </Button>
          )}
          {canUpdate && (
            <Button size="sm" disabled={pending} onClick={() => void view.install(tool.id, true)}>
              Güncelle
            </Button>
          )}
          {tool.removable && !installing && view.online && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => void view.uninstall(tool.id)}
            >
              Kaldır
            </Button>
          )}
          {installing && <Spinner size={12} />}
        </div>
      </div>
      <div className="selectable pl-6 text-footnote text-fg-2">
        {tool.purpose}{" "}
        <span className="text-fg-3">
          Kaynak: {tool.source}
          {tool.state !== "installed" ? ` · ${formatToolSize(tool.sizeBytes)}` : ""}
        </span>
      </div>
      {installing && (
        <div className="flex flex-col gap-1 pl-6">
          <ProgressBar value={tool.progress} />
          {tool.note && <span className="text-footnote text-fg-2">{tool.note}</span>}
        </div>
      )}
      {!installing && tool.note && tool.state !== "installed" && (
        <div className="selectable pl-6 text-footnote text-fg-2">{tool.note}</div>
      )}
      {tool.state === "installed" && tool.path && (
        <div className="selectable truncate pl-6 font-mono text-caption text-fg-3">{tool.path}</div>
      )}
      {tool.error && <div className="selectable pl-6 text-footnote text-danger">{tool.error}</div>}
    </li>
  );
}

/** Every tool, for Ayarlar → Gelişmiş → Araçlar. */
export function ToolsList() {
  const view = useTools();
  return (
    <div className="flex flex-col gap-2">
      {!view.online && (
        <div className="text-footnote text-fg-2">
          Mac'teki worker bağlı değil; kurulum sunucu çalışınca yapılabilir.
        </div>
      )}
      {view.tools.length === 0 ? (
        <div className="text-footnote text-fg-2">Araç listesi henüz gelmedi.</div>
      ) : (
        <ul className="flex flex-col" aria-label="Araçlar">
          {view.tools.map((t) => (
            <ToolRow key={t.id} tool={t} view={view} />
          ))}
        </ul>
      )}
      {view.error && <div className="selectable text-footnote text-danger">{view.error}</div>}
      <div>
        <Button size="sm" onClick={() => void view.refresh()}>
          Yeniden ara
        </Button>
      </div>
    </div>
  );
}

/**
 * A feature's missing tool: "<araç> gerekli · Kur" (with progress while it installs). Renders
 * nothing when the tool is there, or when the worker never reported (no guessing).
 */
export function ToolRequired({ id, className }: { id: ToolId; className?: string }) {
  const view = useTools();
  const tool = view.find(id);
  if (!tool || tool.state === "installed") return null;
  const label = tool.label;
  if (tool.state === "installing") {
    return (
      <div className={`flex items-center gap-2 text-footnote text-fg-2 ${className ?? ""}`}>
        <Spinner size={12} />
        <span>
          {label} kuruluyor… {tool.progress !== null ? `%${Math.round(tool.progress * 100)}` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className={`flex flex-wrap items-center gap-2 text-footnote ${className ?? ""}`}>
      <span className="text-accent-text">
        {label} gerekli{tool.state === "failed" && tool.error ? ` (${tool.error})` : ""}
      </span>
      {tool.installable && view.online ? (
        <Button
          size="sm"
          variant="primary"
          disabled={view.busy === id}
          onClick={() => void view.install(id, tool.state === "outdated")}
        >
          Kur · {formatToolSize(tool.sizeBytes)}
        </Button>
      ) : (
        <span className="text-fg-2">{tool.note ?? "Ayarlar → Gelişmiş → Araçlar"}</span>
      )}
      {view.error && <span className="text-danger">{view.error}</span>}
    </div>
  );
}
