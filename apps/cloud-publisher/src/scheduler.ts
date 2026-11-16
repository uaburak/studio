/**
 * Scheduler Durable Object: the single owner of every publish order.
 *
 * Why one SQLite-backed Durable Object (and not D1 + cron):
 * - its alarm wakes it at the exact due time (cron is minute-granular),
 * - it runs one event at a time, so two wake-ups can never drive the same
 *   order concurrently: no leases or claim queries needed,
 * - its storage is transactional and colocated with the code, and writes are
 *   durable before the next outgoing request leaves (output gate), which is
 *   exactly the "persist, then act" rule @studio/publishers asks for,
 * - nothing to provision besides the R2 bucket. Volume is a handful of posts
 *   a day, far below what one object handles.
 *
 * Driving rule (see packages/publishers/README.md): every `publisher.step`
 * result is persisted before anything else happens. A crash mid-step resumes
 * from the last persisted state; the state machines reconcile with Meta
 * before any publish call, so nothing is published twice.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  CloudOrder,
  CloudOrderCreate,
  CloudOrderMedia,
  CloudOrderStatus,
  CloudPublishError,
  CloudPublisherErrorCode,
  CloudPublishKind,
  CloudPublishLogEntry,
  CloudPublishLogEvent,
  CloudTargetStatus,
} from "@studio/contract";
import { cloudPlatformOf } from "@studio/contract";
import {
  type Clock,
  createPublisher,
  type MediaReader,
  PublishError,
  type PublishErrorData,
  type Publishers,
  type PublishState,
  type StepOutcome,
  systemClock,
  validateRequest,
} from "@studio/publishers";
import { buildRequest } from "./build-request.ts";
import { decryptToken, encryptToken, importTokenKey, signMediaPath } from "./crypto.ts";

/** Signed media URLs stay valid this long after publishing starts. */
export const MEDIA_URL_TTL_MS = 24 * 3600_000;
/** Media is deleted from R2 this long after every target finished. */
export const MEDIA_RETENTION_MS = 3 * 24 * 3600_000;
/** Driver-level restarts after a retryable failure the state machine gave up on. */
export const MAX_RESUMES = 6;
export const RESUME_DELAY_MS = 15 * 60_000;
export const QUOTA_RETRY_MS = 60 * 60_000;
/** One wake-up does at most this much, then re-arms the alarm. */
const MAX_STEPS_PER_TICK = 100;
const TICK_BUDGET_MS = 60_000;
/** If a wake-up dies mid-step, the alarm fires again this soon. */
const WATCHDOG_MS = 60_000;

export interface SchedulerDeps {
  clock: Clock;
  publisher: Publishers;
  /** Test hook: runs after a step returned, before its result is persisted. Throw to simulate a crash. */
  beforePersist?: (info: { orderId: string; targetId: string; status: string }) => void;
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: CloudPublisherErrorCode;
        message: string;
        issues?: { path: string; message: string }[];
      };
    };

type StoredMedia = CloudOrderMedia & { uploaded: boolean };

type OrderRow = {
  id: string;
  content_id: string;
  version_id: string;
  content_hash: string;
  scheduled_at: number;
  caption: string | null;
  title: string | null;
  is_ai_generated: number;
  media: string;
  status: string;
  cancelled_at: number | null;
  purge_after: number | null;
  purged: number;
  created_at: number;
  updated_at: number;
};

type TargetRow = {
  order_id: string;
  id: string;
  position: number;
  kind: string;
  account_external_id: string;
  token: string | null;
  status: string;
  state: string | null;
  next_run_at: number | null;
  attempts: number;
  resumes: number;
  external_id: string | null;
  post_id: string | null;
  permalink: string | null;
  published_at: number | null;
  error: string | null;
  updated_at: number;
};

type LogRow = {
  seq: number;
  order_id: string;
  target_id: string | null;
  attempt: number;
  event: string;
  external_id: string | null;
  post_id: string | null;
  permalink: string | null;
  error: string | null;
  retry_at: number | null;
  at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  caption TEXT,
  title TEXT,
  is_ai_generated INTEGER NOT NULL DEFAULT 0,
  media TEXT NOT NULL,
  status TEXT NOT NULL,
  cancelled_at INTEGER,
  purge_after INTEGER,
  purged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_updated ON orders (updated_at, id);
CREATE TABLE IF NOT EXISTS targets (
  order_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  token TEXT,
  status TEXT NOT NULL,
  state TEXT,
  next_run_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  resumes INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  post_id TEXT,
  permalink TEXT,
  published_at INTEGER,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (order_id, id)
);
CREATE INDEX IF NOT EXISTS targets_due ON targets (status, next_run_at);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  target_id TEXT,
  attempt INTEGER NOT NULL,
  event TEXT NOT NULL,
  external_id TEXT,
  post_id TEXT,
  permalink TEXT,
  error TEXT,
  retry_at INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_order ON log (order_id, seq);
`;

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
const tokenAad = (orderId: string, targetId: string) => `token\n${orderId}\n${targetId}`;
export const mediaKey = (orderId: string, sha256: string) => `orders/${orderId}/${sha256}`;

const fail = <T>(
  code: CloudPublisherErrorCode,
  message: string,
  issues?: { path: string; message: string }[],
): RpcResult<T> => ({ ok: false, error: { code, message, ...(issues ? { issues } : {}) } });

function errorOf(e: PublishErrorData | CloudPublishError): CloudPublishError {
  return { code: e.code, message: e.message, action: e.action };
}

/** Logs carry ids and codes only; never tokens, captions or URLs. */
function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...data }));
}

export class Scheduler extends DurableObject<Env> {
  /** Replaced in tests (fake Graph API, fake clock). Not reachable over RPC. */
  deps: SchedulerDeps | undefined;
  private running: Promise<void> | null = null;
  private tokenKey: Promise<CryptoKey> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private getDeps(): SchedulerDeps {
    this.deps ??= {
      clock: systemClock,
      publisher: createPublisher({
        ...(this.env.META_APP_SECRET ? { appSecret: this.env.META_APP_SECRET } : {}),
        // Graph client events are already redacted (method, path ids, status).
        logger: (e) => {
          if (e.level !== "debug") console.log(JSON.stringify({ src: "graph", ...e }));
        },
      }),
    };
    return this.deps;
  }

  private key(): Promise<CryptoKey> {
    this.tokenKey ??= importTokenKey(this.env.TOKEN_ENCRYPTION_KEY);
    return this.tokenKey;
  }

  // --- RPC: orders -------------------------------------------------------------------

  async putOrder(
    id: string,
    input: CloudOrderCreate,
  ): Promise<RpcResult<{ order: CloudOrder; created: boolean }>> {
    const now = this.getDeps().clock.now();
    const scheduledAt = Date.parse(input.scheduledAt);
    if (!(scheduledAt > now)) {
      return fail("validation_error", "scheduledAt must be in the future", [
        { path: "scheduledAt", message: "must be in the future" },
      ]);
    }
    const order = {
      caption: input.caption ?? null,
      title: input.title ?? null,
      isAiGenerated: input.isAiGenerated ?? false,
      media: input.media,
    };
    // Pre-flight with placeholder URLs so content problems surface now, not at publish time.
    const issues: { path: string; message: string }[] = [];
    input.targets.forEach((t, i) => {
      const report = validateRequest(
        buildRequest(order, t, (m) => `https://media.invalid/${encodeURIComponent(m)}`),
      );
      for (const e of report.errors) {
        issues.push({ path: `targets.${i}${e.path ? `.${e.path}` : ""}`, message: e.message });
      }
    });
    if (issues.length > 0) return fail("validation_error", "order cannot be published", issues);

    const key = await this.key();
    const sealed = await Promise.all(
      input.targets.map((t) => encryptToken(key, t.accessToken, tokenAad(id, t.id))),
    );

    // Synchronous from here: no other event can interleave.
    const existing = this.orderRow(id);
    if (existing) {
      if (existing.cancelled_at !== null) return fail("conflict", "order was cancelled");
      if (this.targetRows(id).some((t) => t.status !== "pending")) {
        return fail("conflict", "order already started publishing");
      }
    }
    const old: StoredMedia[] = existing ? JSON.parse(existing.media) : [];
    const uploadedShas = new Set(old.filter((m) => m.uploaded).map((m) => m.sha256));
    const media: StoredMedia[] = input.media.map((m) => ({
      ...m,
      uploaded: uploadedShas.has(m.sha256),
    }));
    const keep = new Set(media.map((m) => m.sha256));
    const stale = [...new Set(old.map((m) => m.sha256))].filter((s) => !keep.has(s));

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO orders (id, content_id, version_id, content_hash, scheduled_at, caption, title,
           is_ai_generated, media, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
         ON CONFLICT (id) DO UPDATE SET content_id = excluded.content_id,
           version_id = excluded.version_id, content_hash = excluded.content_hash,
           scheduled_at = excluded.scheduled_at, caption = excluded.caption, title = excluded.title,
           is_ai_generated = excluded.is_ai_generated, media = excluded.media,
           updated_at = excluded.updated_at`,
        id,
        input.contentId,
        input.versionId,
        input.contentHash,
        scheduledAt,
        order.caption,
        order.title,
        order.isAiGenerated ? 1 : 0,
        JSON.stringify(media),
        now,
        now,
      );
      this.sql.exec("DELETE FROM targets WHERE order_id = ?", id);
      input.targets.forEach((t, i) => {
        this.sql.exec(
          `INSERT INTO targets (order_id, id, position, kind, account_external_id, token, status,
             next_run_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          id,
          t.id,
          i,
          t.kind,
          t.accountExternalId,
          sealed[i] ?? null,
          scheduledAt,
          now,
        );
      });
      this.touchOrder(id, now);
    });
    log("order.saved", { orderId: id, created: !existing, targets: input.targets.length });

    await this.deleteMedia(id, stale);
    await this.armAlarm();
    return { ok: true, value: { order: this.toOrder(id), created: !existing } };
  }

  async cancelOrder(id: string): Promise<RpcResult<CloudOrder>> {
    const row = this.orderRow(id);
    if (!row) return fail("not_found", "order not found");
    if (row.cancelled_at === null) {
      if (this.targetRows(id).some((t) => t.status !== "pending")) {
        return fail("conflict", "order already started publishing");
      }
      const now = this.getDeps().clock.now();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE orders SET cancelled_at = ?, purged = 1 WHERE id = ?", now, id);
        this.sql.exec(
          `UPDATE targets SET status = 'cancelled', token = NULL, next_run_at = NULL,
             updated_at = ? WHERE order_id = ?`,
          now,
          id,
        );
        this.addLog(id, null, 0, "cancelled", now, {});
        this.touchOrder(id, now);
      });
      log("order.cancelled", { orderId: id });
      const media: StoredMedia[] = JSON.parse(row.media);
      await this.deleteMedia(
        id,
        media.map((m) => m.sha256),
      );
      await this.armAlarm();
    }
    return { ok: true, value: this.toOrder(id) };
  }

  getOrder(id: string): RpcResult<CloudOrder> {
    if (!this.orderRow(id)) return fail("not_found", "order not found");
    return { ok: true, value: this.toOrder(id) };
  }

  listOrders(query: {
    status?: CloudOrderStatus | undefined;
    updatedSince?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): RpcResult<{ items: CloudOrder[]; nextCursor: string | null }> {
    let after: { t: number; id: string } | null = null;
    if (query.cursor) {
      try {
        const parsed = JSON.parse(atob(query.cursor));
        if (typeof parsed?.t !== "number" || typeof parsed?.id !== "string") throw new Error();
        after = parsed;
      } catch {
        return fail("validation_error", "invalid cursor", [{ path: "cursor", message: "invalid" }]);
      }
    }
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.status) {
      where.push("status = ?");
      args.push(query.status);
    }
    if (query.updatedSince) {
      where.push("updated_at >= ?");
      args.push(Date.parse(query.updatedSince));
    }
    if (after) {
      where.push("(updated_at > ? OR (updated_at = ? AND id > ?))");
      args.push(after.t, after.t, after.id);
    }
    const rows = this.sql
      .exec<{ id: string; updated_at: number }>(
        `SELECT id, updated_at FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at, id LIMIT ?`,
        ...args,
        query.limit + 1,
      )
      .toArray();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? btoa(JSON.stringify({ t: last.updated_at, id: last.id }))
        : null;
    return { ok: true, value: { items: page.map((r) => this.toOrder(r.id)), nextCursor } };
  }

  getLog(id: string): RpcResult<{ items: CloudPublishLogEntry[] }> {
    if (!this.orderRow(id)) return fail("not_found", "order not found");
    const rows = this.sql
      .exec<LogRow>("SELECT * FROM log WHERE order_id = ? ORDER BY seq", id)
      .toArray();
    return {
      ok: true,
      value: {
        items: rows.map((r) => ({
          seq: r.seq,
          orderId: r.order_id,
          targetId: r.target_id,
          attempt: r.attempt,
          event: r.event as CloudPublishLogEvent,
          externalId: r.external_id,
          postId: r.post_id,
          permalink: r.permalink,
          error: r.error ? (JSON.parse(r.error) as CloudPublishError) : null,
          retryAt: isoOrNull(r.retry_at),
          at: iso(r.at),
        })),
      },
    };
  }

  // --- RPC: media --------------------------------------------------------------------

  /** Check an upload is allowed and tell the Worker where and what to store. */
  prepareUpload(
    id: string,
    mediaId: string,
  ): RpcResult<{ key: string; sha256: string; bytes: number; mimeType: string }> {
    const row = this.orderRow(id);
    if (!row) return fail("not_found", "order not found");
    if (row.cancelled_at !== null) return fail("conflict", "order was cancelled");
    if (this.targetRows(id).some((t) => t.status !== "pending")) {
      return fail("conflict", "order already started publishing");
    }
    const media = (JSON.parse(row.media) as StoredMedia[]).find((m) => m.id === mediaId);
    if (!media) return fail("not_found", "media not declared in this order");
    return {
      ok: true,
      value: {
        key: mediaKey(id, media.sha256),
        sha256: media.sha256,
        bytes: media.bytes,
        mimeType: media.mimeType,
      },
    };
  }

  /** Mark a verified upload. Refused if the order changed meanwhile. */
  confirmUpload(id: string, mediaId: string, sha256: string): RpcResult<CloudOrder> {
    const row = this.orderRow(id);
    if (!row) return fail("not_found", "order not found");
    if (row.cancelled_at !== null) return fail("conflict", "order was cancelled");
    if (this.targetRows(id).some((t) => t.status !== "pending")) {
      return fail("conflict", "order already started publishing");
    }
    const media = JSON.parse(row.media) as StoredMedia[];
    const entry = media.find((m) => m.id === mediaId);
    if (!entry || entry.sha256 !== sha256) return fail("conflict", "order media changed");
    // The same file may be declared under several ids: mark them all.
    for (const m of media) if (m.sha256 === sha256) m.uploaded = true;
    const now = this.getDeps().clock.now();
    this.sql.exec("UPDATE orders SET media = ? WHERE id = ?", JSON.stringify(media), id);
    this.touchOrder(id, now);
    return { ok: true, value: this.toOrder(id) };
  }

  /** R2 key behind a signed media URL, or null if the order no longer serves media. */
  mediaObject(id: string, mediaId: string): { key: string; mimeType: string } | null {
    const row = this.orderRow(id);
    if (!row || row.cancelled_at !== null || row.purged) return null;
    const media = (JSON.parse(row.media) as StoredMedia[]).find((m) => m.id === mediaId);
    if (!media?.uploaded) return null;
    return { key: mediaKey(id, media.sha256), mimeType: media.mimeType };
  }

  // --- wake-ups ------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.tick();
  }

  /** Drive every due target. Concurrent calls (alarm + cron) share one run. */
  tick(): Promise<void> {
    this.running ??= this.runDue().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runDue(): Promise<void> {
    const deps = this.getDeps();
    // If this run dies mid-step, wake up again soon and resume.
    await this.ctx.storage.setAlarm(deps.clock.now() + WATCHDOG_MS);
    const startedAt = Date.now();
    for (let i = 0; i < MAX_STEPS_PER_TICK && Date.now() - startedAt < TICK_BUDGET_MS; i++) {
      const due = this.sql
        .exec<TargetRow>(
          `SELECT t.* FROM targets t JOIN orders o ON o.id = t.order_id
           WHERE t.status IN ('pending', 'publishing') AND t.next_run_at <= ?
             AND o.cancelled_at IS NULL
           ORDER BY t.next_run_at, t.order_id, t.position LIMIT 1`,
          deps.clock.now(),
        )
        .toArray()[0];
      if (!due) break;
      await this.advance(due, deps);
    }
    await this.purgeMedia(deps.clock.now());
    await this.armAlarm();
  }

  private async advance(target: TargetRow, deps: SchedulerDeps): Promise<void> {
    const order = this.orderRow(target.order_id);
    if (!order) return;
    const ids = { orderId: order.id, targetId: target.id };

    if (target.status === "pending") {
      const media: StoredMedia[] = JSON.parse(order.media);
      const now = deps.clock.now();
      if (media.some((m) => !m.uploaded)) {
        this.finishFailed(target, target.attempts, now, {
          code: "MEDIA_MISSING",
          message: "Yayın zamanı geldiğinde medya dosyalarının hepsi yüklenmemişti.",
          action: "fix_content",
        });
        return;
      }
      // Claim synchronously: from now on cancel/replace are refused.
      const attempt = target.attempts + 1;
      this.sql.exec(
        "UPDATE targets SET status = 'publishing', attempts = ?, updated_at = ? WHERE order_id = ? AND id = ?",
        attempt,
        now,
        order.id,
        target.id,
      );
      this.addLog(order.id, target.id, attempt, "started", now, {});
      this.touchOrder(order.id, now);
      log("target.started", { ...ids, attempt });

      const exp = Math.floor((now + MEDIA_URL_TTL_MS) / 1000);
      const urls = new Map<string, string>();
      const base = this.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
      for (const m of media) {
        urls.set(
          m.id,
          base + (await signMediaPath(this.env.MEDIA_URL_SECRET, order.id, m.id, exp)),
        );
      }
      let state: PublishState;
      try {
        const request = buildRequest(
          {
            caption: order.caption,
            title: order.title,
            isAiGenerated: order.is_ai_generated === 1,
            media,
          },
          { kind: target.kind as CloudPublishKind, accountExternalId: target.account_external_id },
          (mediaId) => urls.get(mediaId) ?? "",
        );
        state = deps.publisher.start(request);
      } catch (err) {
        const error =
          err instanceof PublishError
            ? errorOf(err.data)
            : ({
                code: "INVALID_REQUEST",
                message: "Yayın isteği oluşturulamadı.",
                action: "fix_content",
              } satisfies CloudPublishError);
        this.finishFailed({ ...target, status: "publishing" }, attempt, deps.clock.now(), error);
        return;
      }
      this.sql.exec(
        "UPDATE targets SET state = ?, next_run_at = ?, updated_at = ? WHERE order_id = ? AND id = ?",
        JSON.stringify(state),
        deps.clock.now(),
        deps.clock.now(),
        order.id,
        target.id,
      );
      return;
    }

    // status === "publishing": one step of the state machine.
    if (!target.state || !target.token) {
      this.finishFailed(target, target.attempts, deps.clock.now(), {
        code: "INVALID_STATE",
        message: "Yayın durumu ya da erişim anahtarı bulunamadı.",
        action: "manual_check",
      });
      return;
    }
    const accessToken = await decryptToken(
      await this.key(),
      target.token,
      tokenAad(order.id, target.id),
    );
    const storedMedia: StoredMedia[] = JSON.parse(order.media);
    const out: StepOutcome<PublishState> = await deps.publisher.step(
      JSON.parse(target.state) as PublishState,
      { accessToken, media: this.orderMediaReader(order.id, storedMedia) },
    );
    deps.beforePersist?.({ ...ids, status: out.status });

    const now = deps.clock.now();
    // Persist the new state first, in the same write as the next wake-up.
    this.sql.exec(
      "UPDATE targets SET state = ?, next_run_at = ?, updated_at = ? WHERE order_id = ? AND id = ?",
      JSON.stringify(out.state),
      out.status === "wait" ? out.resumeAt : now,
      now,
      order.id,
      target.id,
    );

    switch (out.status) {
      case "continue":
        return;
      case "wait":
        if (out.reason === "retry" && out.state.lastError) {
          this.addLog(order.id, target.id, target.attempts, "retry_scheduled", now, {
            error: errorOf(out.state.lastError),
            retryAt: out.resumeAt,
          });
          log("target.retry", { ...ids, code: out.state.lastError.code });
        }
        return;
      case "done": {
        const r = out.result;
        const publishedAt = Date.parse(r.publishedAt);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `UPDATE targets SET status = 'published', token = NULL, next_run_at = NULL,
               external_id = ?, post_id = ?, permalink = ?, published_at = ?, error = NULL,
               updated_at = ? WHERE order_id = ? AND id = ?`,
            r.externalId,
            r.postId,
            r.permalink,
            Number.isNaN(publishedAt) ? now : publishedAt,
            now,
            order.id,
            target.id,
          );
          this.addLog(order.id, target.id, target.attempts, "succeeded", now, {
            externalId: r.externalId,
            postId: r.postId,
            permalink: r.permalink,
          });
          this.touchOrder(order.id, now);
        });
        log("target.published", { ...ids, externalId: r.externalId, reconciled: r.reconciled });
        return;
      }
      case "failed": {
        const e = out.error;
        const canResume =
          out.state.phase !== "failed" && e.retryable && target.resumes < MAX_RESUMES;
        if (!canResume) {
          this.finishFailed(target, target.attempts, now, errorOf(e));
          return;
        }
        const delay =
          e.action === "wait_quota"
            ? QUOTA_RETRY_MS
            : Math.max(RESUME_DELAY_MS, e.retryAfterMs ?? 0);
        const attempt = target.attempts + 1;
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `UPDATE targets SET attempts = ?, resumes = resumes + 1, next_run_at = ?, error = ?,
               updated_at = ? WHERE order_id = ? AND id = ?`,
            attempt,
            now + delay,
            JSON.stringify(errorOf(e)),
            now,
            order.id,
            target.id,
          );
          this.addLog(order.id, target.id, attempt, "retry_scheduled", now, {
            error: errorOf(e),
            retryAt: now + delay,
          });
          this.touchOrder(order.id, now);
        });
        log("target.resume_scheduled", { ...ids, code: e.code, attempt });
        return;
      }
    }
  }

  private finishFailed(target: TargetRow, attempt: number, now: number, error: CloudPublishError) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE targets SET status = 'failed', token = NULL, next_run_at = NULL, error = ?,
           updated_at = ? WHERE order_id = ? AND id = ?`,
        JSON.stringify(error),
        now,
        target.order_id,
        target.id,
      );
      this.addLog(target.order_id, target.id, attempt, "failed", now, { error });
      this.touchOrder(target.order_id, now);
    });
    log("target.failed", { orderId: target.order_id, targetId: target.id, code: error.code });
  }

  /** Point the alarm at the next due target or media purge (or clear it). */
  private async armAlarm(): Promise<void> {
    const next = this.sql
      .exec<{ t: number | null }>(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(t.next_run_at) AS t FROM targets t JOIN orders o ON o.id = t.order_id
             WHERE t.status IN ('pending', 'publishing') AND o.cancelled_at IS NULL
           UNION ALL
           SELECT MIN(purge_after) AS t FROM orders WHERE purged = 0 AND purge_after IS NOT NULL
         )`,
      )
      .one().t;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private async purgeMedia(now: number): Promise<void> {
    const rows = this.sql
      .exec<{ id: string; media: string }>(
        "SELECT id, media FROM orders WHERE purged = 0 AND purge_after IS NOT NULL AND purge_after <= ?",
        now,
      )
      .toArray();
    for (const row of rows) {
      this.sql.exec("UPDATE orders SET purged = 1 WHERE id = ?", row.id);
      await this.deleteMedia(
        row.id,
        (JSON.parse(row.media) as StoredMedia[]).map((m) => m.sha256),
      );
    }
  }

  private async deleteMedia(orderId: string, shas: string[]): Promise<void> {
    const keys = [...new Set(shas)].map((s) => mediaKey(orderId, s));
    if (keys.length > 0) await this.env.MEDIA.delete(keys);
  }

  private orderMediaReader(orderId: string, media: StoredMedia[]): MediaReader {
    return {
      read: async (key, range) => {
        const entry = media.find((m) => m.id === key || mediaKey(orderId, m.sha256) === key);
        const r2Key = entry ? mediaKey(orderId, entry.sha256) : key;
        const object = await this.env.MEDIA.get(r2Key, {
          range:
            range.length !== undefined
              ? { offset: range.offset, length: range.length }
              : { offset: range.offset },
        });
        if (!object || !("body" in object)) {
          throw new Error(`stored media missing for ${key}`);
        }
        return object.body;
      },
    };
  }

  // --- rows -> API shapes --------------------------------------------------------------

  private orderRow(id: string): OrderRow | undefined {
    return this.sql.exec<OrderRow>("SELECT * FROM orders WHERE id = ?", id).toArray()[0];
  }

  private targetRows(orderId: string): TargetRow[] {
    return this.sql
      .exec<TargetRow>("SELECT * FROM targets WHERE order_id = ? ORDER BY position", orderId)
      .toArray();
  }

  /** Recompute the derived order status and bump `updated_at` (sync cursor). */
  private touchOrder(id: string, now: number) {
    const row = this.orderRow(id);
    if (!row) return;
    const statuses = this.targetRows(id).map((t) => t.status as CloudTargetStatus);
    const media: StoredMedia[] = JSON.parse(row.media);
    let status: CloudOrderStatus;
    let purgeAfter: number | null = null;
    if (row.cancelled_at !== null) status = "cancelled";
    else if (statuses.every((s) => s === "pending"))
      status = media.every((m) => m.uploaded) ? "scheduled" : "awaiting_media";
    else if (statuses.some((s) => s === "pending" || s === "publishing")) status = "publishing";
    else {
      const published = statuses.filter((s) => s === "published").length;
      status =
        published === statuses.length
          ? "published"
          : published === 0
            ? "failed"
            : "partially_published";
      purgeAfter = now + MEDIA_RETENTION_MS;
    }
    this.sql.exec(
      "UPDATE orders SET status = ?, purge_after = COALESCE(purge_after, ?), updated_at = MAX(updated_at, ?) WHERE id = ?",
      status,
      purgeAfter,
      now,
      id,
    );
  }

  private addLog(
    orderId: string,
    targetId: string | null,
    attempt: number,
    event: CloudPublishLogEvent,
    at: number,
    extra: {
      externalId?: string | null;
      postId?: string | null;
      permalink?: string | null;
      error?: CloudPublishError;
      retryAt?: number;
    },
  ) {
    this.sql.exec(
      `INSERT INTO log (order_id, target_id, attempt, event, external_id, post_id, permalink, error,
         retry_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      targetId,
      attempt,
      event,
      extra.externalId ?? null,
      extra.postId ?? null,
      extra.permalink ?? null,
      extra.error ? JSON.stringify(extra.error) : null,
      extra.retryAt ?? null,
      at,
    );
  }

  private toOrder(id: string): CloudOrder {
    const row = this.orderRow(id);
    if (!row) throw new Error(`order ${id} vanished`);
    return {
      id: row.id,
      contentId: row.content_id,
      versionId: row.version_id,
      contentHash: row.content_hash,
      scheduledAt: iso(row.scheduled_at),
      status: row.status as CloudOrderStatus,
      caption: row.caption,
      title: row.title,
      isAiGenerated: row.is_ai_generated === 1,
      media: JSON.parse(row.media) as StoredMedia[],
      // Deliberately field by field: the token column never leaves this object.
      targets: this.targetRows(id).map((t) => ({
        id: t.id,
        platform: cloudPlatformOf(t.kind as CloudPublishKind),
        kind: t.kind as CloudPublishKind,
        accountExternalId: t.account_external_id,
        status: t.status as CloudTargetStatus,
        attempts: t.attempts,
        nextRunAt: isoOrNull(t.next_run_at),
        externalId: t.external_id,
        postId: t.post_id,
        permalink: t.permalink,
        publishedAt: isoOrNull(t.published_at),
        error: t.error ? (JSON.parse(t.error) as CloudPublishError) : null,
      })),
      cancelledAt: isoOrNull(row.cancelled_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}
