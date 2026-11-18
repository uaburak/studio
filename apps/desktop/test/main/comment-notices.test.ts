// N15 / N16 notices from the main process: a finished `comments.sync` with new comments posts one
// notice (quoted for one, counted for several) that opens Yorumlar; statistics reads and comment
// reads without news stay silent.
import { describe, expect, it } from "vitest";
import { ActivityNotices, type ActivitySocketEvents } from "../../src/main/activity-notices.ts";
import type { NoticeInput } from "../../src/shared/ipc.ts";
import {
  commentsNotice,
  finishedNotice,
  JOB_LABELS,
  jobTitle,
  noticeRoute,
} from "../../src/shared/notices.ts";

const job = (over: Record<string, unknown>) => ({
  id: "j1",
  type: "comments.sync",
  status: "succeeded",
  payload: {},
  ...over,
});

describe("comment notices", () => {
  it("quotes one new comment, counts several, opens Yorumlar", () => {
    expect(
      commentsNotice(
        job({ output: { newComments: 1, sample: { author: "ayse", text: "Fiyat?" } } }),
      ),
    ).toEqual({ id: "comments-j1", title: "Yeni yorum", body: "ayse: Fiyat?", route: "comments" });
    expect(commentsNotice(job({ output: { newComments: 4, sample: null } }))).toEqual({
      id: "comments-j1",
      title: "4 yeni yorum",
      body: "Yorumlar sayfasında yanıtlayabilirsiniz.",
      route: "comments",
    });
    const long = "a".repeat(200);
    expect(
      commentsNotice(job({ output: { newComments: 1, sample: { author: null, text: long } } }))
        ?.body,
    ).toHaveLength(118);
  });

  it("says nothing without news, for failures and for statistics reads", () => {
    expect(commentsNotice(job({ output: { newComments: 0 } }))).toBeNull();
    expect(commentsNotice(job({ status: "failed", output: { newComments: 3 } }))).toBeNull();
    expect(finishedNotice(job({ output: {} }), "Yorum eşitleme")).toBeNull();
    expect(finishedNotice(job({ type: "insights.sync" }), "İstatistik eşitleme")).toBeNull();
    expect(finishedNotice(job({ type: "comments.suggest" }), "Yanıt önerisi")).toBeNull();
  });

  it("names and routes the new jobs", () => {
    expect(JOB_LABELS["insights.sync"]).toBe("İstatistik eşitleme");
    expect(jobTitle(job({ type: "comments.sync" }))).toBe("Yorum eşitleme");
    expect(jobTitle(job({ type: "comments.suggest" }))).toBe("Yanıt önerisi");
    expect(noticeRoute(job({ type: "comments.suggest" }) as never)).toBe("comments");
    expect(noticeRoute(job({ type: "insights.sync" }) as never)).toBe("performance");
  });

  it("the job stream watcher posts the notice when the sync finishes", () => {
    const opened: { url: string; events: ActivitySocketEvents }[] = [];
    const posted: NoticeInput[] = [];
    const notices = new ActivityNotices({
      target: () => ({ port: 8790, ownerSecret: "own" }),
      socket: (url, _headers, events) => {
        opened.push({ url, events });
        return { close: () => undefined };
      },
      getJson: async () => null,
      post: (n) => posted.push(n),
      windowFocused: () => false,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    notices.start();
    const stream = opened.find((s) => s.url.includes("/api/jobs/stream"));
    const push = (frame: unknown) => stream?.events.onMessage(JSON.stringify(frame));
    push({ type: "jobs.snapshot", jobs: [] });
    push({ type: "job.updated", job: job({ status: "running" }) });
    push({
      type: "job.updated",
      job: job({ output: { newComments: 2, sample: { author: "ali", text: "Merhaba" } } }),
    });
    push({ type: "job.updated", job: job({ id: "j2", type: "insights.sync", status: "running" }) });
    push({
      type: "job.updated",
      job: job({ id: "j2", type: "insights.sync", status: "succeeded" }),
    });
    expect(posted).toEqual([
      {
        id: "comments-j1",
        title: "2 yeni yorum",
        body: "Yorumlar sayfasında yanıtlayabilirsiniz.",
        route: "comments",
      },
    ]);
    notices.stop();
  });
});
