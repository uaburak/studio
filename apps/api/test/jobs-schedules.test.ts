import { env } from "cloudflare:workers";
import { Content, Job, JobList, PublishLogList, Schedule, ScheduleList } from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  addVersion,
  api,
  approvedContent,
  createAccount,
  createBrand,
  createContent,
  expectError,
  getContent,
  inOneHour,
} from "./helpers.ts";

describe("jobs", () => {
  it("persists a queued job tied to a brand and content", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const res = await api("POST", "/api/jobs", {
      type: "content.generate",
      contentId: content.id,
      payload: { prompt: "Hasat postu" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const job = Job.parse(res.body);
    expect(job).toMatchObject({
      type: "content.generate",
      status: "queued",
      brandId: brand.id,
      contentId: content.id,
      payload: { prompt: "Hasat postu" },
    });

    expect(Job.parse((await api("GET", `/api/jobs/${job.id}`)).body)).toEqual(job);
    const list = JobList.parse((await api("GET", `/api/jobs?contentId=${content.id}`)).body);
    expect(list.items.map((j) => j.id)).toEqual([job.id]);
  });

  it("creates brand-less demo jobs and validates their payload", async () => {
    const ok = await api("POST", "/api/jobs", { type: "demo.echo", payload: { text: "merhaba" } });
    expect(ok.status).toBe(201);
    expect(Job.parse(ok.body)).not.toHaveProperty("brandId");
    const err = expectError(
      await api("POST", "/api/jobs", { type: "demo.echo", payload: { text: 42 } }),
      400,
      "validation_error",
    );
    expect(err.issues?.[0]?.path).toBe("payload.text");
  });

  it("rejects unknown types, missing references and mismatched brands", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const content = await createContent(brand.id);
    expectError(await api("POST", "/api/jobs", { type: "nuke" }), 400, "validation_error");
    expectError(
      await api("POST", "/api/jobs", { type: "content.render" }),
      400,
      "validation_error",
    );
    expectError(await api("POST", "/api/jobs", { type: "brand.analyze" }), 400, "validation_error");
    expectError(
      await api("POST", "/api/jobs", { type: "brand.analyze", brandId: "missing" }),
      404,
      "not_found",
    );
    expectError(
      await api("POST", "/api/jobs", { type: "content.render", contentId: "missing" }),
      404,
      "not_found",
    );
    expectError(
      await api("POST", "/api/jobs", {
        type: "content.render",
        contentId: content.id,
        brandId: other.id,
      }),
      400,
      "validation_error",
    );
    expectError(await api("GET", "/api/jobs/missing"), 404, "not_found");
  });
});

describe("schedules", () => {
  it("schedules approved content, freezes the version, and cancels back to approved", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const { content, version } = await approvedContent(brand.id);
    const scheduledAt = inOneHour();

    const res = await api("POST", "/api/schedules", {
      contentId: content.id,
      socialAccountId: account.id,
      scheduledAt,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const schedule = Schedule.parse(res.body);
    expect(schedule).toMatchObject({
      platform: "instagram",
      status: "pending",
      brandId: brand.id,
      versionId: version.id,
      contentHash: version.contentHash,
      scheduledAt,
    });
    expect((await getContent(content.id)).status).toBe("scheduled");

    // One active schedule per content + account.
    expectError(
      await api("POST", "/api/schedules", {
        contentId: content.id,
        socialAccountId: account.id,
        scheduledAt,
      }),
      409,
      "conflict",
    );

    const list = ScheduleList.parse(
      (await api("GET", `/api/schedules?contentId=${content.id}`)).body,
    );
    expect(list.items.map((s) => s.id)).toEqual([schedule.id]);
    const logs = PublishLogList.parse(
      (await api("GET", `/api/schedules/${schedule.id}/logs`)).body,
    );
    expect(logs).toEqual({ items: [], nextCursor: null });

    const cancelled = Schedule.parse(
      (await api("POST", `/api/schedules/${schedule.id}/cancel`)).body,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect((await getContent(content.id)).status).toBe("approved");
    expectError(
      await api("POST", `/api/schedules/${schedule.id}/cancel`),
      409,
      "invalid_transition",
    );
  });

  it("stays scheduled while another schedule is pending", async () => {
    const brand = await createBrand();
    const ig = await createAccount(brand.id);
    const fb = await createAccount(brand.id, { platform: "facebook" });
    const { content } = await approvedContent(brand.id, {
      targetPlatforms: ["instagram", "facebook"],
    });
    const a = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: ig.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    await api("POST", "/api/schedules", {
      contentId: content.id,
      socialAccountId: fb.id,
      scheduledAt: inOneHour(),
    });
    await api("POST", `/api/schedules/${a.id}/cancel`);
    expect((await getContent(content.id)).status).toBe("scheduled");
  });

  it("a new version cancels pending schedules and returns the content to draft", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const { content } = await approvedContent(brand.id);
    const schedule = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    await addVersion(content.id, {
      origin: "manual_edit",
      slides: [{ html: "<p>v2</p>", width: 1080, height: 1350 }],
    });
    const after = Content.parse(await getContent(content.id));
    expect(after.status).toBe("draft");
    const s = Schedule.parse((await api("GET", `/api/schedules/${schedule.id}`)).body);
    expect(s.status).toBe("cancelled");
  });

  it("refuses unapproved content, foreign accounts, wrong platforms and past times", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const account = await createAccount(brand.id);
    const foreign = await createAccount(other.id);
    const linkedin = await createAccount(brand.id, { platform: "linkedin" });
    const disabled = await createAccount(brand.id, { status: "disabled" });

    const draft = await createContent(brand.id);
    await addVersion(draft.id);
    const base = { contentId: draft.id, socialAccountId: account.id, scheduledAt: inOneHour() };
    expectError(await api("POST", "/api/schedules", base), 409, "invalid_transition");

    const { content } = await approvedContent(brand.id);
    const ok = { ...base, contentId: content.id };
    expectError(
      await api("POST", "/api/schedules", { ...ok, scheduledAt: "2020-01-01T00:00:00.000Z" }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", "/api/schedules", { ...ok, platform: "facebook" }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", "/api/schedules", { ...ok, socialAccountId: foreign.id }),
      409,
      "conflict",
    );
    expectError(
      await api("POST", "/api/schedules", { ...ok, socialAccountId: linkedin.id }),
      409,
      "conflict",
    );
    expectError(
      await api("POST", "/api/schedules", { ...ok, socialAccountId: disabled.id }),
      409,
      "conflict",
    );
    expectError(
      await api("POST", "/api/schedules", { ...ok, socialAccountId: "missing" }),
      404,
      "not_found",
    );
    expectError(await api("GET", "/api/schedules/missing"), 404, "not_found");
    expectError(await api("GET", "/api/schedules/missing/logs"), 404, "not_found");
  });

  it("lists schedules in time order with a time-based cursor and reads publish logs", async () => {
    const brand = await createBrand();
    const accounts = [
      await createAccount(brand.id),
      await createAccount(brand.id),
      await createAccount(brand.id),
    ];
    const { content } = await approvedContent(brand.id);
    const times = [3, 1, 2].map((h) => new Date(Date.now() + h * 3_600_000).toISOString());
    const made: Schedule[] = [];
    for (const [i, account] of accounts.entries()) {
      made.push(
        Schedule.parse(
          (
            await api("POST", "/api/schedules", {
              contentId: content.id,
              socialAccountId: account.id,
              scheduledAt: times[i],
            })
          ).body,
        ),
      );
    }
    const first = ScheduleList.parse(
      (await api("GET", `/api/schedules?brandId=${brand.id}&limit=2`)).body,
    );
    const second = ScheduleList.parse(
      (
        await api(
          "GET",
          `/api/schedules?brandId=${brand.id}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        )
      ).body,
    );
    expect([...first.items, ...second.items].map((s) => s.scheduledAt)).toEqual([...times].sort());
    expect(second.nextCursor).toBeNull();
    expectError(await api("GET", "/api/schedules?cursor=garbage"), 400, "validation_error");

    // Publish logs are written by the (future) engine; reading works today.
    const schedule = made[0];
    if (!schedule) throw new Error("no schedule");
    await env.DB.prepare(
      "insert into publish_logs (id, schedule_id, attempt, status, started_at, created_at) values (?, ?, 1, 'failed', ?, ?)",
    )
      .bind("log-1", schedule.id, Date.now(), Date.now())
      .run();
    const logs = PublishLogList.parse(
      (await api("GET", `/api/schedules/${schedule.id}/logs`)).body,
    );
    expect(logs.items).toMatchObject([{ attempt: 1, status: "failed", externalPostId: null }]);
  });
});
