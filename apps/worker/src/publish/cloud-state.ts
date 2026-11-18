/**
 * State shared by the `schedule.publish` handler and the schedule poller (P3):
 * which schedule versions already reached the cloud publisher, and the cloud
 * publisher config read from the API (the Mac sets it in Ayarlar → Yayın).
 *
 * Keyed by the deps object, so each worker runtime (and each test) has its own.
 */

import { ApiError, DEFAULT_MAX_LATENESS_MINUTES } from "@studio/contract";
import type { AgentSettings } from "../agent.ts";
import type { StudioApi } from "../api.ts";

/** Maximum lateness when the API does not say (S6: 2 hours). */
export const DEFAULT_MAX_LATENESS_MS = DEFAULT_MAX_LATENESS_MINUTES * 60_000;

export interface CloudPublisherConfig {
  url: string;
  token: string;
}

interface SharedState {
  /** schedule id -> `${versionId}:${scheduledAt}:${contentHash}` last pushed. */
  pushed: Map<string, string>;
  /**
   * schedule (target) id -> `${status}:${attempts}:${permalink}` last written back from the
   * cloud. A (re)push clears it, so a retried order's next outcome is never mistaken for
   * the one already reported.
   */
  reported: Map<string, string>;
  config: {
    value: CloudPublisherConfig | null;
    syncRequestedAt: string | null;
    maxLatenessMs: number;
    at: number;
  } | null;
}

const shared = new WeakMap<object, SharedState>();

export function cloudState(deps: object): SharedState {
  let s = shared.get(deps);
  if (!s) {
    s = { pushed: new Map(), reported: new Map(), config: null };
    shared.set(deps, s);
  }
  return s;
}

export function pushKey(s: {
  versionId: string;
  scheduledAt: string;
  contentHash: string;
  /** N13: bumped when the post's publish details change; a new revision pushes again. */
  detailsRevision?: number | undefined;
}): string {
  const base = `${s.versionId}:${s.scheduledAt}:${s.contentHash}`;
  return s.detailsRevision ? `${base}:d${s.detailsRevision}` : base;
}

interface ConfigDeps {
  api: StudioApi;
  settings: Pick<AgentSettings, "parentEnv" | "cloudPublisherUrl" | "cloudPublisherToken">;
}

/** Cloud publisher from the worker's environment (`STUDIO_CLOUD_PUBLISHER_URL` / `_TOKEN`). */
export function envCloudPublisherConfig(deps: ConfigDeps): CloudPublisherConfig | null {
  const url = (
    deps.settings.parentEnv.STUDIO_CLOUD_PUBLISHER_URL ?? deps.settings.cloudPublisherUrl
  )?.trim();
  const token = (
    deps.settings.parentEnv.STUDIO_CLOUD_PUBLISHER_TOKEN ?? deps.settings.cloudPublisherToken
  )?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export interface ResolvedPublishingConfig {
  cloud: CloudPublisherConfig | null;
  syncRequestedAt: string | null;
  maxLatenessMs: number;
  /**
   * Set when the publishing path is unknown (the API says the cloud publisher is set but
   * unreadable, or the API could not be asked yet): publish nothing this round. Falling back
   * to local publishing would publish what the cloud publisher also holds.
   */
  unavailable: string | null;
}

/**
 * The effective cloud publisher: the environment wins (development, tests), otherwise
 * what the Mac saved through the API. Cached for `maxAgeMs`; `cloud: null` = publish locally.
 */
export async function resolveCloudPublisherConfig(
  deps: ConfigDeps,
  opts: { maxAgeMs?: number; signal?: AbortSignal; now?: number } = {},
): Promise<ResolvedPublishingConfig> {
  const fromEnv = envCloudPublisherConfig(deps);
  const state = cloudState(deps);
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 5_000;
  if (state.config && now - state.config.at < maxAge) {
    return {
      cloud: fromEnv ?? state.config.value,
      syncRequestedAt: state.config.syncRequestedAt,
      maxLatenessMs: state.config.maxLatenessMs,
      unavailable: null,
    };
  }
  try {
    const remote = await deps.api.client.workerPublishing.config(
      opts.signal ? { signal: opts.signal } : undefined,
    );
    const value = remote.cloud
      ? { url: remote.cloud.url.replace(/\/+$/, ""), token: remote.cloud.token }
      : null;
    const maxLatenessMs = remote.maxLatenessMs ?? DEFAULT_MAX_LATENESS_MS;
    state.config = { value, syncRequestedAt: remote.syncRequestedAt, maxLatenessMs, at: now };
    return {
      cloud: fromEnv ?? value,
      syncRequestedAt: remote.syncRequestedAt,
      maxLatenessMs,
      unavailable: null,
    };
  } catch (error) {
    if (fromEnv) {
      return {
        cloud: fromEnv,
        syncRequestedAt: state.config?.syncRequestedAt ?? null,
        maxLatenessMs: state.config?.maxLatenessMs ?? DEFAULT_MAX_LATENESS_MS,
        unavailable: null,
      };
    }
    // The cloud publisher is set but its token cannot be read: never publish locally then.
    if (error instanceof ApiError && error.status === 409) {
      state.config = null;
      return {
        cloud: null,
        syncRequestedAt: null,
        maxLatenessMs: DEFAULT_MAX_LATENESS_MS,
        unavailable: error.message.replace(/^\/api\/[^:]*:\s*/, ""),
      };
    }
    // Not reachable right now: keep the last known value; without one, wait.
    if (state.config) {
      return {
        cloud: state.config.value,
        syncRequestedAt: state.config.syncRequestedAt,
        maxLatenessMs: state.config.maxLatenessMs,
        unavailable: null,
      };
    }
    return {
      cloud: null,
      syncRequestedAt: null,
      maxLatenessMs: DEFAULT_MAX_LATENESS_MS,
      unavailable: "Yayın ayarları okunamadı; bu tur yayın yapılmadı.",
    };
  }
}
