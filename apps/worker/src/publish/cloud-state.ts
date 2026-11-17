/**
 * State shared by the `schedule.publish` handler and the schedule poller (P3):
 * which schedule versions already reached the cloud publisher, and the cloud
 * publisher config read from the API (the Mac sets it in Ayarlar → Yayın).
 *
 * Keyed by the deps object, so each worker runtime (and each test) has its own.
 */

import type { AgentSettings } from "../agent.ts";
import type { StudioApi } from "../api.ts";

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
  config: { value: CloudPublisherConfig | null; syncRequestedAt: string | null; at: number } | null;
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
}): string {
  return `${s.versionId}:${s.scheduledAt}:${s.contentHash}`;
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

/**
 * The effective cloud publisher: the environment wins (development, tests), otherwise
 * what the Mac saved through the API. Cached for `maxAgeMs`; `null` = publish locally.
 */
export async function resolveCloudPublisherConfig(
  deps: ConfigDeps,
  opts: { maxAgeMs?: number; signal?: AbortSignal; now?: number } = {},
): Promise<{ cloud: CloudPublisherConfig | null; syncRequestedAt: string | null }> {
  const fromEnv = envCloudPublisherConfig(deps);
  const state = cloudState(deps);
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 5_000;
  if (state.config && now - state.config.at < maxAge) {
    return { cloud: fromEnv ?? state.config.value, syncRequestedAt: state.config.syncRequestedAt };
  }
  try {
    const remote = await deps.api.client.workerPublishing.config(
      opts.signal ? { signal: opts.signal } : undefined,
    );
    const value = remote.cloud
      ? { url: remote.cloud.url.replace(/\/+$/, ""), token: remote.cloud.token }
      : null;
    state.config = { value, syncRequestedAt: remote.syncRequestedAt, at: now };
    return { cloud: fromEnv ?? value, syncRequestedAt: remote.syncRequestedAt };
  } catch {
    // Older API, or not reachable: keep the last known value.
    return {
      cloud: fromEnv ?? state.config?.value ?? null,
      syncRequestedAt: state.config?.syncRequestedAt ?? null,
    };
  }
}
