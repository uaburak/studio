import { describe, expect, it } from "vitest";
import {
  classifyTokenHealth,
  exchangeForLongLivedUserToken,
  FACEBOOK_PUBLISH_SCOPES,
  INSTAGRAM_PUBLISH_SCOPES,
  inspectToken,
  listManagedPages,
  type TokenInfo,
} from "../src/index.ts";
import { IG, PAGE, PAGE_TOKEN, setup, USER_TOKEN } from "./helpers.ts";

const DAY = 24 * 3600_000;

describe("listManagedPages", () => {
  it("returns pages with tokens, tasks and linked Instagram accounts across pagination", async () => {
    const env = setup();
    for (let i = 0; i < 150; i++)
      env.fake.addPage(String(900000 + i), `EAApage${i}${"C".repeat(30)}`, { tasks: ["ANALYZE"] });
    const pages = await listManagedPages(env.publisher.graph, USER_TOKEN);
    expect(pages).toHaveLength(151);
    expect(env.fake.routeCalls("me.accounts")).toHaveLength(2);
    const main = pages.find((p) => p.id === PAGE);
    expect(main).toMatchObject({
      name: "MTM Agro",
      accessToken: PAGE_TOKEN,
      canPublish: true,
      instagram: { id: IG, username: `ig_${IG}` },
    });
    expect(pages.find((p) => p.id === "900000")?.canPublish).toBe(false);
    expect(env.fake.routeCalls("me.accounts")[0]?.query.fields).toContain(
      "instagram_business_account{id,username,name}",
    );
  });
});

describe("exchangeForLongLivedUserToken", () => {
  it("exchanges and computes expiresAt; secrets never leak into errors", async () => {
    const env = setup();
    const res = await exchangeForLongLivedUserToken(env.publisher.graph, {
      appId: env.fake.opts.appId,
      appSecret: env.fake.opts.appSecret,
      shortLivedToken: USER_TOKEN,
    });
    expect(res.accessToken).toMatch(/^EAAlong/);
    expect(res.expiresAt).toBe(env.clock.now() + 5183944 * 1000);

    const bad = await exchangeForLongLivedUserToken(env.publisher.graph, {
      appId: env.fake.opts.appId,
      appSecret: "wrong-secret-value",
      shortLivedToken: USER_TOKEN,
    }).catch((e) => e);
    expect(JSON.stringify(bad)).not.toContain("wrong-secret-value");
    expect(String(bad)).not.toContain(USER_TOKEN);
  });
});

describe("inspectToken + classifyTokenHealth", () => {
  const appToken = (env: ReturnType<typeof setup>) =>
    `${env.fake.opts.appId}|${env.fake.opts.appSecret}`;

  it("page token: never expires, valid", async () => {
    const env = setup();
    const info = await inspectToken(env.publisher.graph, {
      inputToken: PAGE_TOKEN,
      appAccessToken: appToken(env),
    });
    expect(info).toMatchObject({ isValid: true, expiresAt: null, profileId: PAGE, type: "PAGE" });
    const health = classifyTokenHealth(info, {
      requiredScopes: FACEBOOK_PUBLISH_SCOPES,
      now: env.clock.now(),
    });
    // Data access still expires (90 days) even when the token itself does not.
    expect(health.status).toBe("valid");
    expect(health.deadline).toBe(info.dataAccessExpiresAt);
  });

  it("expired user token is invalid", async () => {
    const env = setup();
    env.fake.expireToken(USER_TOKEN);
    const info = await inspectToken(env.publisher.graph, {
      inputToken: USER_TOKEN,
      appAccessToken: appToken(env),
    });
    expect(info.isValid).toBe(false);
    expect(classifyTokenHealth(info, { requiredScopes: [], now: env.clock.now() })).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("yeniden bağlayın"),
    });
  });

  it("unknown token is invalid with an error", async () => {
    const env = setup();
    const info = await inspectToken(env.publisher.graph, {
      inputToken: "EAAnope0000000000000000000000",
      appAccessToken: appToken(env),
    });
    expect(info).toMatchObject({ isValid: false, error: { code: 190, subcode: 467 } });
  });

  const base: TokenInfo = {
    isValid: true,
    appId: "1",
    userId: "2",
    profileId: null,
    type: "USER",
    scopes: [...INSTAGRAM_PUBLISH_SCOPES],
    granularScopes: [],
    expiresAt: null,
    dataAccessExpiresAt: null,
    issuedAt: null,
    error: null,
  };
  const now = Date.UTC(2026, 10, 16);

  it("missing scopes", () => {
    const h = classifyTokenHealth(
      { ...base, scopes: ["instagram_basic"] },
      { requiredScopes: INSTAGRAM_PUBLISH_SCOPES, now },
    );
    expect(h.status).toBe("missing_scopes");
    expect(h.missingScopes).toEqual([
      "instagram_content_publish",
      "pages_show_list",
      "pages_read_engagement",
    ]);
  });

  it("granular scopes must cover the target account", () => {
    const info = {
      ...base,
      granularScopes: [{ scope: "instagram_content_publish", targetIds: ["other"] }],
    };
    expect(
      classifyTokenHealth(info, { requiredScopes: INSTAGRAM_PUBLISH_SCOPES, now, targetId: IG })
        .missingScopes,
    ).toEqual(["instagram_content_publish"]);
    expect(
      classifyTokenHealth(info, {
        requiredScopes: INSTAGRAM_PUBLISH_SCOPES,
        now,
        targetId: "other",
      }).status,
    ).toBe("valid");
  });

  it("expiring soon uses the earliest of token and data-access expiry", () => {
    const h = classifyTokenHealth(
      { ...base, expiresAt: now + 40 * DAY, dataAccessExpiresAt: now + 3 * DAY },
      { requiredScopes: [], now },
    );
    expect(h).toMatchObject({ status: "expiring_soon", deadline: now + 3 * DAY });
    expect(h.message).toContain("3 gün");
    expect(
      classifyTokenHealth({ ...base, expiresAt: now + 40 * DAY }, { requiredScopes: [], now })
        .status,
    ).toBe("valid");
    expect(
      classifyTokenHealth({ ...base, expiresAt: now - 1 }, { requiredScopes: [], now }).status,
    ).toBe("invalid");
  });
});
