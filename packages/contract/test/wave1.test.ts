import { describe, expect, it } from "vitest";
import {
  AssetKind,
  assetMimeRule,
  BrandAnalyzePayload,
  CloudOrderCreate,
  CloudPlatform,
  CloudPublishKind,
  ContentRenderPayload,
  cloudPlatformOf,
  createApiClient,
  ImageGeneratePayload,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  JobType,
  LinkedInConnectInput,
  MetaDiscoverInput,
  MetaDiscoverResult,
  PublishLog,
  Schedule,
  SchedulePublishPayload,
  SocialAccount,
  SocialAccountTokenPut,
  TokenHealthStatus,
  WorkerDueSchedules,
  WorkerScheduleCredentials,
  WorkerScheduleOutcome,
} from "../src/index.ts";

describe("assets: document & audio kinds", () => {
  it("supports document (PDF) and audio MIME rules while preserving image/video/other compatibility", () => {
    expect(AssetKind.options).toContain("document");
    expect(AssetKind.options).toContain("audio");

    const pdf = assetMimeRule("application/pdf");
    expect(pdf?.defaultKind).toBe("document");
    expect(pdf?.kinds).toEqual(["document", "other"]);
    expect(pdf?.ext).toBe(".pdf");

    expect(assetMimeRule("audio/mpeg")?.defaultKind).toBe("audio");
    expect(assetMimeRule("audio/mp4")?.defaultKind).toBe("audio");
    expect(assetMimeRule("audio/x-m4a")?.defaultKind).toBe("audio");
    expect(assetMimeRule("audio/wav")?.defaultKind).toBe("audio");
    expect(assetMimeRule("audio/aac")?.defaultKind).toBe("audio");
  });
});

describe("jobs: Wave 1 types and payload schemas", () => {
  it("registers image.generate and schedule.publish in JobType and JOB_TYPE_REQUIREMENTS", () => {
    expect(JobType.options).toContain("image.generate");
    expect(JobType.options).toContain("schedule.publish");
    expect(JOB_TYPE_REQUIREMENTS["image.generate"]).toEqual({ brand: true, content: false });
    expect(JOB_TYPE_REQUIREMENTS["schedule.publish"]).toEqual({ brand: true, content: true });
    expect(JOB_PAYLOAD_SCHEMAS["image.generate"]).toBe(ImageGeneratePayload);
    expect(JOB_PAYLOAD_SCHEMAS["schedule.publish"]).toBe(SchedulePublishPayload);
  });

  it("validates ContentRenderPayload, ImageGeneratePayload, BrandAnalyzePayload, SchedulePublishPayload", () => {
    expect(ContentRenderPayload.parse({})).toEqual({ format: "jpeg" });
    expect(
      ContentRenderPayload.parse({
        version: 2,
        format: "both",
        slotAssignments: { hero: "asset-1" },
        patches: [{ op: "replace", selector: "h1", text: "Yeni" }],
      }),
    ).toMatchObject({ version: 2, format: "both" });

    expect(ImageGeneratePayload.parse({ prompt: "  Tarlada traktör  " })).toEqual({
      prompt: "Tarlada traktör",
      aspectRatio: "4:5",
      imageSize: "2K",
      referenceAssetIds: [],
      preserveProductLabel: false,
    });
    expect(ImageGeneratePayload.safeParse({ prompt: "   " }).success).toBe(false);

    expect(BrandAnalyzePayload.parse({})).toEqual({
      samplePosts: [],
      includeApprovedContentFeedback: true,
      autoApprove: false,
    });
    expect(
      BrandAnalyzePayload.parse({
        notes: "Kurumsal ton",
        samplePosts: [{ caption: "Hasat #1", likes: 120, comments: 8 }],
        model: "sonnet",
        effort: "high",
      }),
    ).toMatchObject({ model: "sonnet", effort: "high" });

    expect(SchedulePublishPayload.parse({ scheduleId: "sched-1" })).toEqual({
      scheduleId: "sched-1",
    });
    expect(SchedulePublishPayload.safeParse({}).success).toBe(false);
  });
});

describe("cloud-publisher: LinkedIn kinds & media rules", () => {
  const baseOrder = {
    contentId: "c1",
    versionId: "v1",
    contentHash: "a".repeat(64),
    scheduledAt: "2026-12-01T09:00:00.000Z",
  };

  it("maps LinkedIn kinds to the linkedin platform", () => {
    const kinds = [
      "linkedin.text",
      "linkedin.image",
      "linkedin.multi_image",
      "linkedin.document",
      "linkedin.video",
    ] as const;
    for (const kind of kinds) {
      expect(CloudPublishKind.parse(kind)).toBe(kind);
      expect(cloudPlatformOf(kind)).toBe("linkedin");
    }
    expect(CloudPlatform.options).toContain("linkedin");
  });

  it("allows empty media ONLY when every target is linkedin.text", () => {
    const liText = {
      id: "t1",
      kind: "linkedin.text" as const,
      accountExternalId: "urn:li:person:abc123",
      accessToken: "AQV-linkedin-token-12345",
    };
    const igImg = {
      id: "t2",
      kind: "instagram.image" as const,
      accountExternalId: "17841400001",
      accessToken: "EAA-instagram-token-12345",
    };

    expect(
      CloudOrderCreate.safeParse({
        ...baseOrder,
        caption: "Metin paylaşımı",
        media: [],
        targets: [liText],
      }).success,
    ).toBe(true);

    expect(
      CloudOrderCreate.safeParse({
        ...baseOrder,
        media: [],
        targets: [igImg],
      }).success,
    ).toBe(false);

    expect(
      CloudOrderCreate.safeParse({
        ...baseOrder,
        media: [],
        targets: [liText, igImg],
      }).success,
    ).toBe(false);

    expect(
      CloudOrderCreate.safeParse({
        ...baseOrder,
        title: "Rapor",
        media: [
          {
            id: "carousel.pdf",
            kind: "document",
            mimeType: "application/pdf",
            bytes: 1024,
            sha256: "b".repeat(64),
          },
        ],
        targets: [{ ...liText, kind: "linkedin.document" }],
      }).success,
    ).toBe(true);
  });
});

describe("social accounts & schedules: token vault + worker endpoints + client", () => {
  const now = "2026-11-16T10:00:00.000Z";
  const accountFixture = {
    id: "acc-1",
    brandId: "b-1",
    platform: "linkedin" as const,
    handle: "Deniz",
    externalId: "urn:li:person:123",
    status: "connected" as const,
    createdAt: now,
    updatedAt: now,
  };

  it("parses SocialAccount with and without optional token health fields", () => {
    expect(SocialAccount.parse(accountFixture)).toEqual(accountFixture);
    const enriched = {
      ...accountFixture,
      hasToken: true,
      tokenExpiresAt: now,
      tokenScopes: ["w_member_social"],
      tokenHealth: "valid" as const,
      tokenCheckedAt: now,
    };
    expect(SocialAccount.parse(enriched)).toEqual(enriched);
    expect(TokenHealthStatus.options).toEqual([
      "valid",
      "expiring_soon",
      "invalid",
      "missing_scopes",
      "unchecked",
    ]);
  });

  it("validates token put, Meta discover and LinkedIn connect schemas", () => {
    expect(
      SocialAccountTokenPut.parse({
        accessToken: "  secret-token-value  ",
        scopes: ["pages_manage_posts"],
      }),
    ).toEqual({
      accessToken: "secret-token-value",
      scopes: ["pages_manage_posts"],
    });

    expect(
      MetaDiscoverInput.parse({
        brandId: "b-1",
        userAccessToken: "EAA-short-token",
      }),
    ).toEqual({
      brandId: "b-1",
      userAccessToken: "EAA-short-token",
      autoConnect: true,
    });

    expect(
      MetaDiscoverResult.parse({
        pages: [
          {
            pageId: "123",
            pageName: "MTM Agro",
            canPublish: true,
            instagram: { igUserId: "456", username: "mtmagro" },
          },
        ],
        connectedAccounts: [accountFixture],
      }).pages,
    ).toHaveLength(1);

    expect(
      LinkedInConnectInput.parse({
        brandId: "b-1",
        handle: "Deniz",
        personUrn: "urn:li:person:123",
        accessToken: "AQV-token-12345",
      }),
    ).toMatchObject({ personUrn: "urn:li:person:123" });
  });

  it("validates schedule permalink and worker schedule schemas", () => {
    const schedule = {
      id: "s-1",
      contentId: "c-1",
      brandId: "b-1",
      platform: "linkedin" as const,
      socialAccountId: "acc-1",
      versionId: "v-1",
      contentHash: "a".repeat(64),
      scheduledAt: now,
      status: "published" as const,
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:1/",
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(Schedule.parse(schedule).permalink).toContain("linkedin.com");

    const log = {
      id: "l-1",
      scheduleId: "s-1",
      attempt: 1,
      status: "succeeded" as const,
      externalPostId: "urn:li:share:1",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:1/",
      error: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    };
    expect(PublishLog.parse(log).permalink).toContain("linkedin.com");

    expect(WorkerDueSchedules.parse({ items: [schedule] }).items).toHaveLength(1);

    const creds = {
      schedule,
      account: accountFixture,
      content: {
        id: "c-1",
        brandId: "b-1",
        type: "post" as const,
        title: "Post",
        brief: "",
        status: "scheduled" as const,
        targetPlatforms: ["linkedin" as const],
        caption: "Merhaba",
        currentVersion: { id: "v-1", version: 1, contentHash: "a".repeat(64) },
        approval: { versionId: "v-1", contentHash: "a".repeat(64), approvedAt: now },
        createdAt: now,
        updatedAt: now,
      },
      version: {
        id: "v-1",
        contentId: "c-1",
        version: 1,
        origin: "generated" as const,
        contentHash: "a".repeat(64),
        slideCount: 1,
        note: null,
        jobId: null,
        createdAt: now,
        updatedAt: now,
        slides: [{ html: "<html/>", width: 1080, height: 1350, renderedAssetId: null }],
      },
      accessToken: "AQV-decrypted",
    };
    expect(WorkerScheduleCredentials.parse(creds).accessToken).toBe("AQV-decrypted");

    expect(WorkerScheduleOutcome.parse({ status: "published" })).toEqual({
      status: "published",
      attempt: 1,
      accountNeedsReauth: false,
    });
  });

  it("wires socialAccounts and workerSchedules client methods", async () => {
    const seen: string[] = [];
    const schedule = {
      id: "s-1",
      contentId: "c-1",
      brandId: "b-1",
      platform: "linkedin",
      socialAccountId: "acc-1",
      versionId: "v-1",
      contentHash: "a".repeat(64),
      scheduledAt: now,
      status: "pending",
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      seen.push(`${init?.method ?? "GET"} ${u}`);
      let body: unknown = accountFixture;
      if (u.endsWith("/meta/discover")) body = { pages: [], connectedAccounts: [accountFixture] };
      else if (u.includes("/worker/schedules/due")) body = { items: [schedule] };
      else if (u.endsWith("/credentials"))
        body = {
          schedule,
          account: accountFixture,
          content: {
            id: "c-1",
            brandId: "b-1",
            type: "post",
            title: "Post",
            brief: "",
            status: "scheduled",
            targetPlatforms: ["linkedin"],
            caption: "",
            currentVersion: { id: "v-1", version: 1, contentHash: "a".repeat(64) },
            approval: { versionId: "v-1", contentHash: "a".repeat(64), approvedAt: now },
            createdAt: now,
            updatedAt: now,
          },
          version: {
            id: "v-1",
            contentId: "c-1",
            version: 1,
            origin: "generated",
            contentHash: "a".repeat(64),
            slideCount: 1,
            note: null,
            jobId: null,
            createdAt: now,
            updatedAt: now,
            slides: [{ html: "<p/>", width: 1080, height: 1080, renderedAssetId: null }],
          },
          accessToken: "tok",
        };
      else if (u.endsWith("/outcome")) body = { ...schedule, status: "published" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = createApiClient({
      baseUrl: "http://api.test",
      workerToken: "wtok",
      fetch: fetchImpl,
    });
    await client.socialAccounts.putToken("acc-1", { accessToken: "12345678" });
    await client.socialAccounts.checkToken("acc-1");
    await client.socialAccounts.discoverMeta({ brandId: "b-1", userAccessToken: "12345678" });
    await client.socialAccounts.connectLinkedIn({
      brandId: "b-1",
      handle: "Deniz",
      personUrn: "urn:li:person:123",
      accessToken: "12345678",
    });
    await client.workerSchedules.due({ before: now });
    await client.workerSchedules.credentials("s-1");
    await client.workerSchedules.outcome("s-1", { status: "published" });

    expect(seen).toEqual([
      "PUT http://api.test/api/social-accounts/acc-1/token",
      "POST http://api.test/api/social-accounts/acc-1/check",
      "POST http://api.test/api/social-accounts/meta/discover",
      "POST http://api.test/api/social-accounts/linkedin/connect",
      `GET http://api.test/api/worker/schedules/due?before=${encodeURIComponent(now)}`,
      "GET http://api.test/api/worker/schedules/s-1/credentials",
      "POST http://api.test/api/worker/schedules/s-1/outcome",
    ]);
  });
});
