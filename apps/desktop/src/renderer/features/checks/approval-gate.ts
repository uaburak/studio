// What the checks say about approving one version (E7), read fresh from the API when Onayla /
// ⌘↩ / Zamanla is pressed — never a cached run that may still be loading or be of the version
// before the one just saved. Waits for the version's run: while a `content.check` of it is
// queued or running, and — when none comes — starts one (the deterministic checks, no model
// pass) as the canvas's save does. The API refuses the same cases (409) unless the approval says
// `acknowledgeChecks`, which the app sends only after the user confirmed.
import {
  type ApiClient,
  anyCheckEnabled,
  type BrandCheckSettings,
  type ContentCheckRun,
  isTerminalJobStatus,
} from "@studio/contract";
import { describeError } from "../../lib/api.ts";
import { type ApprovalWarning, approvalWarning } from "./checks-model.ts";

export type ApprovalGate =
  /** Nothing holds approval back (checked and clean, or every check switched off). */
  | { kind: "clear" }
  /** The version's latest run holds approval back. */
  | { kind: "problems"; run: ContentCheckRun; warning: ApprovalWarning }
  /** No finished run of the version (yet): the user decides. */
  | { kind: "unfinished"; version: number; reason: string };

export type GateApi = {
  contents: { checks: Pick<ApiClient["contents"]["checks"], "list"> };
  jobs: Pick<ApiClient["jobs"], "list" | "create">;
  brandCheckSettings: Pick<ApiClient["brandCheckSettings"], "get">;
};

export interface GateOptions {
  /** How long to wait for the run (default 45 s). */
  timeoutMs?: number;
  pollMs?: number;
  /** Polls with nothing in sight before a check job is started (the save's own may be coming). */
  startAfterPolls?: number;
  /** A Mac worker is connected (no: a queued check can't run — the user is asked at once). */
  workerOnline?: () => boolean;
  /** Each poll (the UI says "Kontroller çalışıyor…"). */
  onWait?: () => void;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** A run of exactly this version (a run of an earlier row with the same number does not count). */
function runOf(
  runs: readonly ContentCheckRun[],
  version: { version: number; id?: string | null },
): ContentCheckRun | null {
  const run = runs[0];
  if (!run || run.version !== version.version) return null;
  if (version.id && run.versionId && run.versionId !== version.id) return null;
  return run;
}

function decide(run: ContentCheckRun, settings: BrandCheckSettings | null): ApprovalGate {
  const warning = approvalWarning(run, settings);
  return warning ? { kind: "problems", run, warning } : { kind: "clear" };
}

/** The checks' answer for approving `version` of `content` (see the top). */
export async function awaitApprovalGate(
  api: GateApi,
  content: { id: string; brandId: string },
  version: { version: number; id?: string | null },
  options: GateOptions = {},
): Promise<ApprovalGate> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollMs = options.pollMs ?? 1_000;
  const startAfter = options.startAfterPolls ?? 2;
  const settings = await api.brandCheckSettings.get(content.brandId).catch(() => null);
  if (settings && !anyCheckEnabled(settings)) return { kind: "clear" };
  const deadline = Date.now() + timeoutMs;
  let started = false;
  let idle = 0;
  let last: ContentCheckRun | null = null;
  for (;;) {
    if (options.signal?.aborted)
      return { kind: "unfinished", version: version.version, reason: "Vazgeçildi." };
    let running = false;
    try {
      const [runs, jobs] = await Promise.all([
        api.contents.checks.list(content.id, { version: version.version, limit: 1 }),
        api.jobs
          .list({ contentId: content.id, type: "content.check", limit: 20 })
          .catch(() => null),
      ]);
      last = runOf(runs.items, version);
      running =
        jobs?.items.some(
          (j) =>
            j.type === "content.check" &&
            !isTerminalJobStatus(j.status) &&
            (j.payload.version === undefined || j.payload.version === version.version),
        ) ?? false;
    } catch (e) {
      return {
        kind: "unfinished",
        version: version.version,
        reason: `Kontroller okunamadı: ${describeError(e)}`,
      };
    }
    if (last && !running) return decide(last, settings);
    if (!last && !running) {
      idle++;
      if (!started && idle >= startAfter) {
        started = true;
        try {
          await api.jobs.create({
            type: "content.check",
            brandId: content.brandId,
            contentId: content.id,
            payload: { version: version.version, model: false },
          });
        } catch (e) {
          return {
            kind: "unfinished",
            version: version.version,
            reason: `Kontroller başlatılamadı: ${describeError(e)}`,
          };
        }
        continue;
      }
    }
    if (!last && options.workerOnline && !options.workerOnline() && (running || started))
      return {
        kind: "unfinished",
        version: version.version,
        reason: "Mac'teki işçi bağlı değil; kontroller çalışamıyor.",
      };
    if (Date.now() >= deadline) {
      // A finished run that already holds approval back says so; otherwise the user decides.
      if (last) {
        const gate = decide(last, settings);
        if (gate.kind === "problems") return gate;
      }
      return {
        kind: "unfinished",
        version: version.version,
        reason: last ? "Yeni kontroller hâlâ sürüyor." : "Kontroller zamanında bitmedi.",
      };
    }
    options.onWait?.();
    await sleep(pollMs, options.signal);
  }
}
