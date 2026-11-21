import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  HOST_LOCKOUT_MESSAGES,
  HOST_SETTINGS_FRESH_MS,
  type HostKeyName,
  HostSettingsChange,
  HostSettingsChangeCreate,
  type HostSettingsPatch,
  HostSettingsPendingChange,
  HostSettingsState,
  HostSettingsSync,
  HostSettingsSyncResult,
  HostSettingsView,
} from "@studio/contract";
import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import type { Context } from "hono";
import { createDb, type Db } from "../db/client.ts";
import { appMeta, type HostKeyChangeRow, hostSettingsChanges } from "../db/schema.ts";
import { conflict } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { type AppEnv, createRouter, errors, json, jsonBody } from "../lib/router.ts";
import {
  decryptSetting,
  encryptSetting,
  VAULT_UNAVAILABLE_MESSAGE,
  vaultReady,
} from "../lib/token-vault.ts";
import { requestRoute, requireLocal, requireOwner } from "../middleware/access.ts";
import { readRoutes } from "./devices.ts";

/*
 * Mac host settings bridge (contract host-settings.ts). The Mac app's main process syncs every
 * few seconds (`POST /api/host/settings/sync`, the Mac itself only): it sends its non-secret
 * state and the results of the changes it applied, and gets the pending changes back (key values
 * unsealed for it). A paired phone reads the last state (`GET /api/host/settings`) and queues
 * changes (`POST /api/host/settings/changes`).
 *
 * State: `app_meta` under STATE_KEY (one writer, the Mac). Changes: one row each in
 * `host_settings_changes`; key values are sealed in the token vault (additional data
 * `host_key:<change id>:<name>`) and erased when the change is finished. Finished rows beyond
 * KEEP_FINISHED are deleted.
 */

const STATE_KEY = "host_settings_state";
/** Finished changes kept for the phone to show ("Uygulandı", "Uygulanamadı: …"). */
const KEEP_FINISHED = 20;
/** Changes in the view (pending + latest finished). */
const VIEW_CHANGES = 10;
/** A pending change the Mac never took (an old Mac app, a closed app) fails after this. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** The Mac rewrites an unchanged state at most this often (keeps `seenAt` fresh). */
const SEEN_REFRESH_MS = 10_000;

const tags = ["Host settings"];
const forbidden = json(ApiErrorBody, "Not called by the owner / the Mac itself (`forbidden`).");

interface StoredState {
  state: HostSettingsState;
  seenAt: string;
}

type ChangeRow = typeof hostSettingsChanges.$inferSelect;

function keyAad(changeId: string, name: string): string {
  return `host_key:${changeId}:${name}`;
}

async function readState(db: Db): Promise<StoredState | null> {
  const row = await db.query.appMeta.findFirst({ where: eq(appMeta.key, STATE_KEY) });
  if (!row) return null;
  try {
    const raw = JSON.parse(row.value) as { state?: unknown; seenAt?: unknown };
    const state = HostSettingsState.safeParse(raw.state);
    if (!state.success || typeof raw.seenAt !== "string") return null;
    return { state: state.data, seenAt: raw.seenAt };
  } catch {
    return null;
  }
}

function toChange(row: ChangeRow): HostSettingsChange {
  return HostSettingsChange.parse({
    id: row.id,
    values: row.values,
    keys: row.keys.map((k) => ({ name: k.name, action: k.action })),
    deviceId: row.deviceId,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  });
}

/** Hostnames that mean "through the tunnel" (the routes the Mac published, its settings). */
async function tunnelHostnames(db: Db, stored: StoredState | null): Promise<string[]> {
  const out: string[] = [];
  const routes = await readRoutes(db);
  if (routes?.tunnelUrl) {
    try {
      out.push(new URL(routes.tunnelUrl).hostname);
    } catch {
      // ignore
    }
  }
  if (stored?.state.values.remoteHostname) out.push(stored.state.values.remoteHostname);
  return out;
}

/**
 * The lockout guard: a change must not cut the route the request came through. Returns the
 * Turkish refusal, or null.
 */
export function lockoutProblem(
  via: "local" | "lan" | "tunnel",
  values: HostSettingsPatch,
  keys: { name: HostKeyName; value: string | null }[],
  current: HostSettingsState["values"] | null,
): string | null {
  if (via === "tunnel") {
    if (values.remoteControlEnabled === false) return HOST_LOCKOUT_MESSAGES.tunnel;
    if (
      values.remoteHostname !== undefined &&
      values.remoteHostname !== (current?.remoteHostname ?? values.remoteHostname)
    ) {
      return HOST_LOCKOUT_MESSAGES.tunnel;
    }
    if (keys.some((k) => k.name === "CLOUDFLARE_TUNNEL_TOKEN")) return HOST_LOCKOUT_MESSAGES.tunnel;
  }
  if (via === "lan" && values.lanEnabled === false) return HOST_LOCKOUT_MESSAGES.lan;
  return null;
}

async function view(c: Context<AppEnv>, db: Db): Promise<HostSettingsView> {
  const stored = await readState(db);
  const [pending, finished] = await Promise.all([
    db
      .select()
      .from(hostSettingsChanges)
      .where(eq(hostSettingsChanges.status, "pending"))
      .orderBy(desc(hostSettingsChanges.createdAt), desc(hostSettingsChanges.id)),
    db
      .select()
      .from(hostSettingsChanges)
      .where(ne(hostSettingsChanges.status, "pending"))
      .orderBy(desc(hostSettingsChanges.createdAt), desc(hostSettingsChanges.id))
      .limit(VIEW_CHANGES),
  ]);
  const seenMs = stored ? Date.parse(stored.seenAt) : Number.NaN;
  return HostSettingsView.parse({
    state: stored?.state ?? null,
    seenAt: stored?.seenAt ?? null,
    live: Number.isFinite(seenMs) && Date.now() - seenMs <= HOST_SETTINGS_FRESH_MS,
    via: requestRoute(c, await tunnelHostnames(db, stored)),
    changes: [...pending, ...finished]
      .slice(0, Math.max(VIEW_CHANGES, pending.length))
      .map(toChange),
  });
}

/** Pending changes as the Mac receives them (key values unsealed). Old ones fail first. */
async function pendingForMac(db: Db, env: Env): Promise<HostSettingsPendingChange[]> {
  const now = Date.now();
  await finish(
    db,
    await db
      .select()
      .from(hostSettingsChanges)
      .where(
        and(
          eq(hostSettingsChanges.status, "pending"),
          lt(hostSettingsChanges.createdAt, new Date(now - PENDING_TTL_MS)),
        ),
      ),
    () => ({ ok: false, message: "Mac bu değişikliği bir gün içinde almadı." }),
  );
  const rows = await db
    .select()
    .from(hostSettingsChanges)
    .where(eq(hostSettingsChanges.status, "pending"))
    .orderBy(hostSettingsChanges.createdAt, hostSettingsChanges.id);
  const out: HostSettingsPendingChange[] = [];
  for (const row of rows) {
    const keys = [];
    let broken = false;
    for (const k of row.keys) {
      if (k.action === "remove") {
        keys.push({ name: k.name, value: null });
        continue;
      }
      try {
        if (!k.sealed) throw new Error("missing");
        keys.push({
          name: k.name,
          value: await decryptSetting(env, keyAad(row.id, k.name), k.sealed),
        });
      } catch {
        broken = true;
      }
    }
    if (broken) {
      await finish(db, [row], () => ({
        ok: false,
        message: "Anahtar kasada çözülemedi (kasa anahtarı değişmiş); yeniden gir.",
      }));
      continue;
    }
    out.push(
      HostSettingsPendingChange.parse({
        id: row.id,
        values: row.values,
        keys,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  }
  return out;
}

/** Mark rows finished, erase their sealed values and trim the history. */
async function finish(
  db: Db,
  rows: ChangeRow[],
  result: (row: ChangeRow) => { ok: boolean; message: string | null },
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  for (const row of rows) {
    const r = result(row);
    await db
      .update(hostSettingsChanges)
      .set({
        status: r.ok ? "applied" : "failed",
        message: r.message?.slice(0, 500) ?? null,
        finishedAt: now,
        keys: row.keys.map((k): HostKeyChangeRow => ({ ...k, sealed: null })),
      })
      .where(and(eq(hostSettingsChanges.id, row.id), eq(hostSettingsChanges.status, "pending")));
  }
  const keep = await db
    .select({ id: hostSettingsChanges.id })
    .from(hostSettingsChanges)
    .where(ne(hostSettingsChanges.status, "pending"))
    .orderBy(desc(hostSettingsChanges.createdAt), desc(hostSettingsChanges.id))
    .limit(KEEP_FINISHED);
  const ids = keep.map((k) => k.id);
  if (ids.length >= KEEP_FINISHED) {
    const old = await db
      .select({ id: hostSettingsChanges.id })
      .from(hostSettingsChanges)
      .where(ne(hostSettingsChanges.status, "pending"));
    const drop = old.map((o) => o.id).filter((id) => !ids.includes(id));
    if (drop.length > 0)
      await db.delete(hostSettingsChanges).where(inArray(hostSettingsChanges.id, drop));
  }
}

const router = createRouter();

router.use("/api/host/settings", requireOwner);
router.use("/api/host/settings/changes", requireOwner);
router.use("/api/host/settings/sync", requireLocal);

export const hostSettingsRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/api/host/settings",
      tags,
      summary: "The Mac app's own settings as it last sent them, and recent changes (owner)",
      description:
        "`state` is null until the Mac app synced once. `live` is false when its last sync is older than 30 s (changes wait). Key values are never returned, only whether each is saved.",
      responses: { 200: json(HostSettingsView, "The settings."), 403: forbidden },
    }),
    async (c) => c.json(await view(c, createDb(c.env.DB)), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/host/settings/changes",
      tags,
      summary: "Queue a change of the Mac app's settings (owner)",
      description:
        "The Mac app applies it on its next sync (a few seconds) and reports the result in the view. Refused (409) when it would cut the route the request came through (turning off remote access, changing its address or token through the tunnel; turning off local network access through the LAN), or when a key must be stored but the vault key is missing.",
      request: { body: jsonBody(HostSettingsChangeCreate) },
      responses: {
        202: json(HostSettingsChange, "Queued."),
        400: errors[400],
        403: forbidden,
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const stored = await readState(db);
      const via = requestRoute(c, await tunnelHostnames(db, stored));
      const problem = lockoutProblem(via, input.values, input.keys, stored?.state.values ?? null);
      if (problem) throw conflict(problem);
      const id = newId();
      const keys: HostKeyChangeRow[] = [];
      if (input.keys.some((k) => k.value !== null) && !vaultReady(c.env)) {
        throw conflict(VAULT_UNAVAILABLE_MESSAGE);
      }
      for (const k of input.keys) {
        keys.push({
          name: k.name,
          action: k.value === null ? "remove" : "set",
          sealed:
            k.value === null ? null : await encryptSetting(c.env, keyAad(id, k.name), k.value),
        });
      }
      const principal = c.get("principal");
      const [row] = await db
        .insert(hostSettingsChanges)
        .values({
          id,
          deviceId: principal?.kind === "device" ? principal.deviceId : null,
          values: input.values,
          keys,
          status: "pending",
          createdAt: new Date(),
        })
        .returning();
      if (!row) throw conflict("could not queue the change");
      return c.json(toChange(row), 202);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/host/settings/sync",
      tags,
      summary: "The Mac app's settings sync: state and results in, pending changes out (Mac only)",
      request: { body: jsonBody(HostSettingsSync) },
      responses: {
        200: json(HostSettingsSyncResult, "Pending changes, oldest first, key values included."),
        400: errors[400],
        403: forbidden,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      // Results first: a finished change is never handed out again.
      if (input.results.length > 0) {
        const byId = new Map(input.results.map((r) => [r.id, r]));
        const rows = await db
          .select()
          .from(hostSettingsChanges)
          .where(
            and(
              eq(hostSettingsChanges.status, "pending"),
              inArray(hostSettingsChanges.id, [...byId.keys()]),
            ),
          );
        await finish(db, rows, (row) => {
          const r = byId.get(row.id);
          return { ok: r?.ok === true, message: r?.message ?? null };
        });
      }
      const stored = await readState(db);
      const now = new Date();
      const same = stored && JSON.stringify(stored.state) === JSON.stringify(input.state);
      if (!same || now.getTime() - Date.parse(stored.seenAt) > SEEN_REFRESH_MS) {
        const value = JSON.stringify({ state: input.state, seenAt: now.toISOString() });
        await db
          .insert(appMeta)
          .values({ key: STATE_KEY, value, updatedAt: now })
          .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } });
      }
      return c.json({ pending: await pendingForMac(db, c.env) }, 200);
    },
  );
