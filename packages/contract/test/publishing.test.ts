import { describe, expect, it } from "vitest";
import {
  CloudOrderCreate,
  isAllowedCloudPublisherUrl,
  missedScheduleMessage,
  PublishingCloudPut,
  PublishingSettingsPatch,
  SCHEDULE_MISSED_PREFIX,
  WorkerDueSchedulesQuery,
  WorkerScheduleClaimResult,
} from "../src/index.ts";

describe("cloud publisher URL (G12)", () => {
  it("allows https, and plain http only to this machine", () => {
    const token = "cloud-token-0123456789abcdef";
    expect(PublishingCloudPut.safeParse({ url: "https://pub.example.com", token }).success).toBe(
      true,
    );
    expect(PublishingCloudPut.safeParse({ url: "http://pub.example.com", token }).success).toBe(
      false,
    );
    expect(PublishingCloudPut.safeParse({ url: "ftp://pub.example.com", token }).success).toBe(
      false,
    );
    for (const local of ["http://127.0.0.1:8788", "http://localhost:8788", "http://[::1]:8788"]) {
      expect(isAllowedCloudPublisherUrl(local), local).toBe(true);
    }
    expect(isAllowedCloudPublisherUrl("http://127.0.0.1.example.com")).toBe(false);
  });
});

describe("maximum lateness (S6)", () => {
  it("says in Turkish why a schedule was missed", () => {
    expect(missedScheduleMessage(120)).toBe(
      "Mac kapalıyken kaçtı: paylaşım saatinden 2 saatten fazla geçtiği için paylaşılmadı. " +
        "Yeniden zamanlayın ya da şimdi paylaşın.",
    );
    expect(missedScheduleMessage(90)).toContain("90 dakikadan");
    expect(missedScheduleMessage(30).startsWith(SCHEDULE_MISSED_PREFIX)).toBe(true);
  });

  it("bounds the setting and carries notAfter on cloud orders", () => {
    expect(PublishingSettingsPatch.safeParse({ maxLatenessMinutes: 120 }).success).toBe(true);
    expect(PublishingSettingsPatch.safeParse({ maxLatenessMinutes: 1 }).success).toBe(false);
    const order = CloudOrderCreate.parse({
      contentId: "c",
      versionId: "v",
      contentHash: "a".repeat(64),
      scheduledAt: "2026-11-18T10:00:00.000Z",
      notAfter: "2026-11-18T12:00:00.000Z",
      media: [],
      targets: [
        {
          id: "t",
          kind: "linkedin.text",
          accountExternalId: "urn:li:person:1",
          accessToken: "x".repeat(20),
        },
      ],
    });
    expect(order.notAfter).toBe("2026-11-18T12:00:00.000Z");
  });
});

describe("worker schedule shapes (Y4, Y5)", () => {
  it("parses the local due filter and a claim result", () => {
    expect(WorkerDueSchedulesQuery.parse({ mode: "local" })).toMatchObject({
      mode: "local",
      limit: 100,
    });
    expect(WorkerDueSchedulesQuery.safeParse({ mode: "elsewhere" }).success).toBe(false);
    const refused = WorkerScheduleClaimResult.safeParse({
      claimed: false,
      reason: "cloud",
      resumed: false,
      schedule: {
        id: "s",
        contentId: "c",
        brandId: "b",
        platform: "linkedin",
        socialAccountId: "a",
        versionId: "v",
        contentHash: "a".repeat(64),
        scheduledAt: "2026-11-18T10:00:00.000Z",
        status: "pending",
        cancelledAt: null,
        createdAt: "2026-11-18T09:00:00.000Z",
        updatedAt: "2026-11-18T09:00:00.000Z",
      },
      publishState: null,
      attempt: 1,
    });
    expect(refused.success).toBe(true);
  });
});
