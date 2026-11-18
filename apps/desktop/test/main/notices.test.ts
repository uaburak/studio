// Main-process notifications (A8): the job stream watcher, the renderer handshake, crash
// recovery; the main log and log helpers (A11).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityNotices,
  type ActivitySocketEvents,
  OWNER_HEADER,
} from "../../src/main/activity-notices.ts";
import { rotateInPlace, tail } from "../../src/main/host/environment.ts";
import { installMainLog, MainLog } from "../../src/main/main-log.ts";
import {
  CRASH_NOTICE,
  HANG_NOTICE,
  type RecoverableContents,
  RendererLink,
  watchRenderer,
} from "../../src/main/renderer-link.ts";
import { IPC, type NoticeInput } from "../../src/shared/ipc.ts";
import {
  finishedNotice,
  JOB_LABELS,
  noticeRoute,
  waitingNotice,
} from "../../src/shared/notices.ts";

// --- the job stream ---------------------------------------------------------------------------

class FakeSockets {
  opened: { url: string; headers: Record<string, string>; events: ActivitySocketEvents }[] = [];
  closed: string[] = [];
  factory = (url: string, headers: Record<string, string>, events: ActivitySocketEvents) => {
    const entry = { url, headers, events };
    this.opened.push(entry);
    return {
      close: () => {
        this.closed.push(url);
        events.onClose();
      },
    };
  };
  last(part: string) {
    const found = [...this.opened].reverse().find((s) => s.url.includes(part));
    if (!found) throw new Error(`no socket for ${part}`);
    return found;
  }
  push(part: string, frame: unknown) {
    this.last(part).events.onMessage(JSON.stringify(frame));
  }
}

const job = (over: Record<string, unknown>) => ({
  id: "j1",
  type: "content.generate",
  status: "running",
  payload: { title: "Hasat postu" },
  ...over,
});

function watcher(over: { focused?: boolean; title?: string } = {}) {
  const sockets = new FakeSockets();
  const posted: NoticeInput[] = [];
  let target: { port: number; ownerSecret: string } | null = { port: 8790, ownerSecret: "own" };
  const timers: (() => void)[] = [];
  const notices = new ActivityNotices({
    target: () => target,
    socket: sockets.factory,
    getJson: vi.fn(async () => ({ title: over.title ?? "Kasım planı" })),
    post: (n) => posted.push(n),
    windowFocused: () => over.focused ?? false,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return {
    notices,
    sockets,
    posted,
    timers,
    setTarget: (t: typeof target) => {
      target = t;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ActivityNotices (main-process notifications)", () => {
  it("follows the job stream with the owner secret and announces finished jobs once", () => {
    const w = watcher();
    w.notices.start();
    const socket = w.sockets.last("/api/jobs/stream");
    expect(socket.url).toBe("ws://127.0.0.1:8790/api/jobs/stream");
    expect(socket.headers).toEqual({ [OWNER_HEADER]: "own" });
    // The first snapshot is only remembered.
    w.sockets.push("/jobs/", { type: "jobs.snapshot", jobs: [job({ status: "succeeded" })] });
    w.sockets.push("/jobs/", { type: "job.updated", job: job({ id: "j2", status: "queued" }) });
    w.sockets.push("/jobs/", { type: "job.updated", job: job({ id: "j2", status: "running" }) });
    expect(w.posted).toEqual([]);
    w.sockets.push("/jobs/", { type: "job.updated", job: job({ id: "j2", status: "succeeded" }) });
    expect(w.posted).toEqual([
      {
        id: "job-j2-succeeded",
        title: "Hasat postu bitti",
        body: "Sonuç Studio'da hazır.",
        route: "posts",
      },
    ]);
  });

  it("names the conversation of a finished reply and opens it on click", async () => {
    const w = watcher({ title: "Kasım planı" });
    w.notices.start();
    w.sockets.push("/jobs/", { type: "jobs.snapshot", jobs: [] });
    const turn = { type: "chat.turn", payload: { conversationId: "c1" } };
    w.sockets.push("/jobs/", { type: "job.updated", job: job({ ...turn, status: "running" }) });
    w.sockets.push("/jobs/", { type: "job.updated", job: job({ ...turn, status: "succeeded" }) });
    await flush();
    expect(w.posted).toEqual([
      { id: "reply-j1", title: "Yanıt hazır", body: "Kasım planı", route: "c:c1" },
    ]);
  });

  it("says nothing while the user looks at the window (the page shows it)", () => {
    const w = watcher({ focused: true });
    w.notices.start();
    w.sockets.push("/jobs/", { type: "jobs.snapshot", jobs: [job({})] });
    w.sockets.push("/jobs/", { type: "job.updated", job: job({ status: "failed" }) });
    expect(w.posted).toEqual([]);
  });

  it("watches a running chat turn's conversation for a consent or a question", () => {
    const w = watcher();
    w.notices.start();
    const turn = job({ id: "t1", type: "chat.turn", payload: { conversationId: "c9" } });
    w.sockets.push("/jobs/", { type: "jobs.snapshot", jobs: [turn] });
    const conv = w.sockets.last("/api/conversations/c9/stream");
    expect(conv.headers).toEqual({ [OWNER_HEADER]: "own" });
    w.sockets.push("/conversations/c9/", {
      type: "conversation.snapshot",
      seq: 3,
      conversation: { id: "c9", title: "Aralık" },
      messages: [
        {
          id: "m1",
          role: "assistant",
          status: "streaming",
          parts: [
            { type: "consent", consentId: "k1", title: "Postu yayınlayayım mı?", state: "pending" },
          ],
        },
      ],
    });
    w.sockets.push("/conversations/c9/", {
      type: "part.added",
      seq: 4,
      messageId: "m1",
      index: 1,
      part: { type: "question", questionId: "q1", prompt: "Hangi gün?", answer: null },
    });
    expect(w.posted.map((n) => [n.id, n.title, n.body, n.route])).toEqual([
      ["consent:m1:k1", "Onayın bekleniyor", "Aralık: Postu yayınlayayım mı?", "c:c9"],
      ["question:m1:q1", "Bir sorusu var", "Aralık: Hangi gün?", "c:c9"],
    ]);
    // The turn ends: the conversation is no longer followed.
    w.sockets.push("/jobs/", { type: "job.updated", job: { ...turn, status: "succeeded" } });
    expect(w.notices.watchedConversations).toEqual([]);
    expect(w.sockets.closed).toContain("ws://127.0.0.1:8790/api/conversations/c9/stream");
  });

  it("reconnects after a drop and follows the host to a new port; stops when it is down", () => {
    const w = watcher();
    w.notices.start();
    w.sockets.last("/jobs/").events.onClose();
    // timers[0] is the token check's; timers[1] the reconnect.
    expect(w.timers).toHaveLength(2);
    w.timers[1]?.();
    expect(w.sockets.opened.filter((s) => s.url.includes("/jobs/"))).toHaveLength(2);
    w.setTarget({ port: 9000, ownerSecret: "own" });
    w.notices.refresh();
    expect(w.sockets.last("/jobs/").url).toBe("ws://127.0.0.1:9000/api/jobs/stream");
    w.setTarget(null);
    w.notices.refresh();
    expect(w.sockets.closed).toContain("ws://127.0.0.1:9000/api/jobs/stream");
  });

  it("asks about Claude's limit in Sor mode once per window, also with the window in front", () => {
    const w = watcher({ focused: true });
    w.notices.start();
    const limit = (over: Record<string, unknown>) => ({
      claude: {
        limit: {
          resetsAt: "2026-11-18T14:30:00.000Z",
          mode: "ask",
          decision: null,
          waiting: 3,
          geminiReady: true,
          ...over,
        },
      },
    });
    w.sockets.push("/jobs/", { type: "jobs.snapshot", jobs: [], presence: limit({}) });
    w.sockets.push("/jobs/", { type: "presence", presence: limit({ waiting: 4 }) });
    // Answered, another mode or nothing waiting: no notice.
    w.sockets.push("/jobs/", { type: "presence", presence: limit({ decision: "wait" }) });
    w.sockets.push("/jobs/", { type: "presence", presence: limit({ mode: "gemini" }) });
    w.sockets.push("/jobs/", { type: "presence", presence: limit({ waiting: 0 }) });
    w.sockets.push("/jobs/", { type: "presence", presence: { claude: {} } });
    expect(w.posted.map((n) => n.id)).toEqual([
      "claude-limit:2026-11-18T14:30:00.000Z",
      "claude-limit:2026-11-18T14:30:00.000Z",
    ]);
    expect(w.posted[0]).toMatchObject({
      title: "Claude sınırı doldu",
      body: "3 iş cevabını bekliyor: Gemini ile devam et ya da sınırı bekle (Ayarlar → Yapay zekâ).",
      route: "settings:ai",
    });
  });

  it("warns about accounts to reconnect from the main process, on connect and every few hours", async () => {
    const sockets = new FakeSockets();
    const posted: NoticeInput[] = [];
    const timers: (() => void)[] = [];
    const now = new Date("2026-11-18T09:00:00.000Z");
    const getJson = vi.fn(async (_t: unknown, path: string) =>
      path.startsWith("/api/social-accounts")
        ? {
            items: [
              {
                id: "a1",
                platform: "instagram",
                handle: "@mtmagro",
                status: "connected",
                hasToken: true,
                tokenHealth: "valid",
                tokenExpiresAt: "2026-11-21T09:00:00.000Z",
              },
              {
                id: "a2",
                platform: "linkedin",
                handle: "Deniz",
                status: "needs_reauth",
                hasToken: true,
              },
              {
                id: "a3",
                platform: "facebook",
                handle: "MTM",
                status: "connected",
                hasToken: true,
              },
            ],
          }
        : {},
    );
    const notices = new ActivityNotices({
      target: () => ({ port: 8790, ownerSecret: "own" }),
      socket: sockets.factory,
      getJson,
      post: (n) => posted.push(n),
      windowFocused: () => true,
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    notices.start();
    sockets.last("/jobs/").events.onOpen();
    await flush();
    expect(getJson).toHaveBeenCalledWith(
      { port: 8790, ownerSecret: "own" },
      "/api/social-accounts?limit=100",
    );
    expect(posted).toEqual([
      {
        id: "token:a1:expiring:20775",
        title: "Hesap bağlantısı yakında doluyor",
        body: "Instagram · @mtmagro: 3 gün içinde yeniden bağlanmalı.",
        route: "settings:accounts",
      },
      {
        id: "token:a2:invalid:20775",
        title: "Hesap yeniden bağlanmalı",
        body: "LinkedIn · Deniz: erişim anahtarı geçersiz. Ayarlar → Hesaplar'dan yeniden bağlayın.",
        route: "settings:accounts",
      },
    ]);
    // A reconnect within the hour does not ask again; the timer does.
    sockets.last("/jobs/").events.onOpen();
    await flush();
    expect(getJson).toHaveBeenCalledTimes(1);
    timers[0]?.();
    await flush();
    expect(getJson).toHaveBeenCalledTimes(2);
    notices.stop();
  });
});

describe("notice texts", () => {
  it("routes each kind of job to its page", () => {
    expect(noticeRoute(job({ type: "schedule.publish" }) as never)).toBe("calendar");
    expect(noticeRoute(job({ type: "image.generate" }) as never)).toBe("media");
    expect(noticeRoute(job({ type: "brand.analyze", brandId: "b1" }) as never)).toBe(
      "brand:b1/profile",
    );
    expect(
      finishedNotice(job({ type: "schedule.publish", status: "failed", error: "token" }), "Post"),
    ).toMatchObject({ title: "Yayın başarısız", body: "Post: token", route: "calendar" });
    expect(finishedNotice(job({ status: "cancelled" }), "x")).toBeNull();
    expect(waitingNotice("c", "", "m", { type: "consent", consentId: "k", state: "allowed" })).toBe(
      null,
    );
  });

  it("says when a product picture's label did not check out (U9)", () => {
    const message = "Etiketteki 1 satır son görselde okunamadı ya da farklı: “GÜBRE 25 KG”.";
    expect(
      finishedNotice(
        {
          ...job({ type: "image.generate", status: "succeeded" }),
          output: { labelCheck: { status: "mismatch", message } },
        },
        "AI görsel üretimi",
      ),
    ).toMatchObject({ title: "AI görsel üretimi bitti, etiketi kontrol et", body: message });
    expect(
      finishedNotice(
        {
          ...job({ type: "image.generate", status: "succeeded" }),
          output: { labelCheck: { status: "ok", message: "Etiket doğrulandı" } },
        },
        "AI görsel üretimi",
      ),
    ).toMatchObject({ title: "AI görsel üretimi bitti", body: "Sonuç Studio'da hazır." });
    expect(JOB_LABELS["media.analyze"]).toBe("Görsel etiketleme");
  });
});

// --- the renderer handshake -----------------------------------------------------------------------

describe("RendererLink (notice click → route after the page is ready)", () => {
  it("delivers a click's route only once the page listens, and again after a reload", () => {
    const sent: unknown[][] = [];
    const link = new RendererLink((...args) => {
      sent.push(args);
      return true;
    });
    // The click created the window: the page is not ready yet.
    link.openRoute("c:c1");
    expect(sent).toEqual([]);
    link.markReady();
    expect(sent).toEqual([[IPC.noticeClicked, "c:c1"]]);
    link.markReady();
    expect(sent).toHaveLength(1);
    // Ready: delivered at once.
    link.openRoute("calendar");
    expect(sent.at(-1)).toEqual([IPC.noticeClicked, "calendar"]);
    // A reload: wait for the page again; only the last click counts.
    link.reset();
    link.openRoute("posts");
    link.openRoute("media");
    link.notice("Pencere yeniden yüklendi.");
    expect(sent).toHaveLength(2);
    link.markReady();
    expect(sent.slice(2)).toEqual([
      [IPC.noticeClicked, "media"],
      [IPC.appNotice, "Pencere yeniden yüklendi."],
    ]);
  });

  it("keeps the route when the window could not take it", () => {
    let alive = false;
    const sent: unknown[][] = [];
    const link = new RendererLink((...args) => {
      if (!alive) return false;
      sent.push(args);
      return true;
    });
    link.markReady();
    link.openRoute("c:x");
    expect(sent).toEqual([]);
    alive = true;
    link.markReady();
    expect(sent).toEqual([[IPC.noticeClicked, "c:x"]]);
  });
});

class Contents implements RecoverableContents {
  listeners = new Map<string, (...args: never[]) => void>();
  reloads = 0;
  crashes = 0;
  on(event: string, listener: (...args: never[]) => void) {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    (this.listeners.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
  }
  reload() {
    this.reloads += 1;
  }
  forcefullyCrashRenderer() {
    this.crashes += 1;
    this.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
  }
  isDestroyed() {
    return false;
  }
}

describe("renderer recovery", () => {
  function setup() {
    const contents = new Contents();
    const sent: unknown[][] = [];
    const link = new RendererLink((...args) => {
      sent.push(args);
      return true;
    });
    link.markReady();
    const timers: (() => void)[] = [];
    const log = vi.fn();
    let now = 0;
    watchRenderer(contents, {
      link,
      log,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => timers.splice(0),
      now: () => now,
    });
    return { contents, sent, link, timers, log, advance: (ms: number) => (now += ms) };
  }

  it("reloads a crashed page and tells it once it is back", () => {
    const r = setup();
    r.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(r.contents.reloads).toBe(1);
    expect(r.link.isReady).toBe(false);
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining("crashed"));
    r.link.markReady();
    expect(r.sent).toEqual([[IPC.appNotice, CRASH_NOTICE]]);
  });

  it("reloads a page that stays unresponsive, not one that recovers", () => {
    const r = setup();
    r.contents.emit("unresponsive");
    r.contents.emit("responsive");
    expect(r.timers).toHaveLength(0);
    r.contents.emit("unresponsive");
    r.timers[0]?.();
    expect(r.contents.crashes).toBe(1);
    // Our own crash is not reported as a second one.
    expect(r.contents.reloads).toBe(1);
    r.link.markReady();
    expect(r.sent).toEqual([[IPC.appNotice, HANG_NOTICE]]);
  });

  it("stops reloading a page that keeps crashing", () => {
    const r = setup();
    for (let i = 0; i < 5; i++) {
      r.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    }
    expect(r.contents.reloads).toBe(3);
    r.advance(61_000);
    r.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(r.contents.reloads).toBe(4);
  });
});

// --- logs ------------------------------------------------------------------------------------------

describe("main log and log files", () => {
  it("writes unhandled rejections, exceptions and console errors, secrets masked", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-log-"));
    const log = new MainLog(join(dir, "desktop.log"));
    const handlers = new Map<string, (value: unknown) => void>();
    const proc = {
      on: (event: string, listener: (value: unknown) => void) => handlers.set(event, listener),
    };
    const target = { warn: vi.fn(), error: vi.fn() };
    installMainLog(log, proc as never, target as never);
    handlers.get("unhandledRejection")?.(new Error("boom"));
    handlers.get("uncaughtException")?.(new Error("kaboom"));
    target.error("bad --token eyJhIjoiMTIzNDU2Nzg5MCJ9");
    const text = readFileSync(join(dir, "desktop.log"), "utf8");
    expect(text).toContain("unhandledRejection: Error: boom");
    expect(text).toContain("uncaughtException: Error: kaboom");
    expect(text).not.toContain("eyJhIjoiMTIzNDU2Nzg5MCJ9");
  });

  it("rotates a log in place (a child keeps writing at the start) and tails only the end", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-rot-"));
    const file = join(dir, "api.log");
    writeFileSync(file, `${"x".repeat(200)}\nlast line\n`);
    expect(rotateInPlace(file, 1_000)).toBe(false);
    expect(rotateInPlace(file, 100)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(readFileSync(`${file}.1`, "utf8")).toContain("last line");
    writeFileSync(file, `${"a\n".repeat(50_000)}tail end\n`);
    expect(tail(file, 1)).toBe("tail end");
    expect(tail(join(dir, "missing.log"))).toBe("");
  });
});
