import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { describeHealth, type HealthState } from "./health-view.ts";

const toneClass = {
  neutral: "bg-zinc-100 text-zinc-700",
  good: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  bad: "bg-rose-50 text-rose-800 ring-1 ring-rose-200",
} as const;

export function App() {
  const [state, setState] = useState<HealthState>({ kind: "loading" });

  const check = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: "loading" });
    try {
      const data = await api.health(signal ? { signal } : undefined);
      setState({ kind: "ok", data });
    } catch (error) {
      if (signal?.aborted) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);

  const view = describeHealth(state);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Studio</h1>
        <p className="text-zinc-500">Sosyal medya üretim ve yayın stüdyosu</p>
      </header>

      <section className={`rounded-xl p-5 ${toneClass[view.tone]}`} aria-live="polite">
        <h2 className="text-lg font-medium">{view.title}</h2>
        <p className="mt-1 text-sm opacity-80">{view.detail}</p>
      </section>

      <button
        type="button"
        onClick={() => void check()}
        className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
      >
        Yeniden kontrol et
      </button>
    </main>
  );
}
