import { AssetKind, TokenHealthStatus } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { toPublishLog, toSchedule, toSocialAccount } from "../src/db/mappers.ts";
import { ENUMS } from "../src/db/schema.ts";
import { discoverMetaPages, exchangeMetaLongLivedToken } from "../src/lib/oauth.ts";
import {
  decryptAccountToken,
  EXPIRING_SOON_MS,
  encryptAccountToken,
  evaluateTokenHealth,
  VAULT_KEY_VERSION,
  vaultReady,
} from "../src/lib/token-vault.ts";

/** How pre-P3 builds sealed tokens (HKDF salt v1), to test the migration path. */
export async function legacySeal(secret: string, accountId: string, plaintext: string) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("studio-token-vault-v1"),
      info: enc.encode("social-account-tokens"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(`social_account_token:${accountId}`) },
      key,
      enc.encode(plaintext),
    ),
  );
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return { ciphertext: b64(ct), iv: b64(iv) };
}

import { deriveContentStatusAfterOutcome } from "../src/routes/worker-schedules.ts";

describe("token-vault AES-256-GCM", () => {
  const KEY = "per-install-vault-key-0123456789abcdef0123";

  it("encrypts and decrypts row-bound tokens and rejects cross-account AAD tampering", async () => {
    const env = { TOKEN_ENCRYPTION_KEY: KEY };
    const plain = "AQV-super-secret-linkedin-token-123456";
    const sealed = await encryptAccountToken(env, "acc-1", plain);

    expect(sealed.keyVersion).toBe(VAULT_KEY_VERSION);
    expect(sealed.ciphertext).not.toContain(plain);
    expect(await decryptAccountToken(env, "acc-1", sealed)).toBe(plain);

    await expect(decryptAccountToken(env, "acc-2", sealed)).rejects.toThrow();
    await expect(
      decryptAccountToken({ TOKEN_ENCRYPTION_KEY: `${KEY}-other` }, "acc-1", sealed),
    ).rejects.toThrow();
  });

  it("refuses to encrypt without a per-install key (no hard-coded fallback)", async () => {
    expect(vaultReady({})).toBe(false);
    expect(vaultReady({ WORKER_TOKEN: "worker-token-only" })).toBe(false);
    expect(vaultReady({ TOKEN_ENCRYPTION_KEY: "too-short" })).toBe(false);
    expect(vaultReady({ TOKEN_ENCRYPTION_KEY: KEY })).toBe(true);
    await expect(encryptAccountToken({}, "acc-local", "local-token-123")).rejects.toThrow(
      /Token kasası anahtarı/,
    );
    await expect(
      encryptAccountToken({ WORKER_TOKEN: "worker-fallback" }, "acc-9", "EAA-page-token-xyz"),
    ).rejects.toThrow(/Token kasası anahtarı/);
  });

  it("still reads legacy (pre-P3) rows so they can be re-encrypted", async () => {
    const legacy = await legacySeal("studio-local-dev-vault", "acc-old", "EAA-legacy-token-1");
    expect(
      await decryptAccountToken({ TOKEN_ENCRYPTION_KEY: KEY }, "acc-old", {
        ...legacy,
        keyVersion: 1,
      }),
    ).toBe("EAA-legacy-token-1");
    const fromWorker = await legacySeal("worker-secret", "acc-w", "EAA-legacy-token-2");
    expect(
      await decryptAccountToken(
        { TOKEN_ENCRYPTION_KEY: KEY, WORKER_TOKEN: "worker-secret" },
        "acc-w",
        {
          ...fromWorker,
          keyVersion: 1,
        },
      ),
    ).toBe("EAA-legacy-token-2");
  });

  it("classifies valid, expiring_soon (<= 7d) and invalid (expired) tokens", () => {
    const now = Date.UTC(2026, 10, 16, 12, 0, 0);
    expect(evaluateTokenHealth(null, now)).toBe("valid");
    expect(evaluateTokenHealth(new Date(now + EXPIRING_SOON_MS + 60_000), now)).toBe("valid");
    expect(evaluateTokenHealth(new Date(now + 3 * 86_400_000), now)).toBe("expiring_soon");
    expect(evaluateTokenHealth(new Date(now - 1_000), now)).toBe("invalid");
  });
});

describe("Meta OAuth discovery helpers", () => {
  it("exchanges short-lived user tokens and discovers Pages + linked Instagram accounts", async () => {
    const now = Date.UTC(2026, 10, 16, 12, 0, 0);
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/oauth/access_token")) {
        expect(u.searchParams.get("grant_type")).toBe("fb_exchange_token");
        expect(u.searchParams.get("client_id")).toBe("app-1");
        return Response.json({ access_token: "EAA-long-lived-user", expires_in: 5_184_000 });
      }
      if (u.pathname.endsWith("/me/accounts")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("OAuth EAA-long-lived-user");
        return Response.json({
          data: [
            {
              id: "page-1",
              name: "MTM Agro",
              access_token: "EAA-page-1-token",
              tasks: ["MANAGE", "CREATE_CONTENT"],
              instagram_business_account: { id: "ig-1", username: "mtmagro" },
            },
            {
              id: "page-2",
              name: "Read Only Page",
              tasks: ["ANALYZE"],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const exchanged = await exchangeMetaLongLivedToken({
      appId: "app-1",
      appSecret: "secret-123456",
      shortLivedToken: "EAA-short-123456",
      fetch: fakeFetch,
      now,
    });
    expect(exchanged.accessToken).toBe("EAA-long-lived-user");
    expect(exchanged.expiresAt?.getTime()).toBe(now + 5_184_000 * 1000);

    const pages = await discoverMetaPages({
      userAccessToken: exchanged.accessToken,
      fetch: fakeFetch,
    });
    expect(pages).toEqual([
      {
        pageId: "page-1",
        pageName: "MTM Agro",
        canPublish: true,
        pageAccessToken: "EAA-page-1-token",
        instagram: { igUserId: "ig-1", username: "mtmagro" },
      },
      {
        pageId: "page-2",
        pageName: "Read Only Page",
        canPublish: false,
        instagram: null,
      },
    ]);
  });

  it("redacts secrets when Meta returns an error", async () => {
    const secret = "superSecretAppKey999";
    const token = "EAAuserSecretToken88888888";
    const failingFetch = (async () =>
      Response.json(
        { error: { message: `Invalid token ${token} for secret ${secret}` } },
        { status: 400 },
      )) as typeof fetch;

    const err = await exchangeMetaLongLivedToken({
      appId: "app-1",
      appSecret: secret,
      shortLivedToken: token,
      fetch: failingFetch,
    }).catch((e: unknown) => e);
    expect(String(err)).not.toContain(secret);
    expect(String(err)).not.toContain(token);
  });
});

describe("mappers & worker schedule status transitions", () => {
  it("keeps ENUMS synced with contract AssetKind and TokenHealthStatus", () => {
    expect([...ENUMS.assetKind]).toEqual([...AssetKind.options]);
    expect([...ENUMS.tokenHealth]).toEqual([...TokenHealthStatus.options]);
  });

  it("never leaks ciphertext/iv on enriched SocialAccount and preserves bare create shape", () => {
    const now = new Date("2026-11-16T10:00:00.000Z");
    const accountRow = {
      id: "acc-1",
      brandId: "b-1",
      platform: "linkedin" as const,
      handle: "Deniz",
      externalId: "urn:li:person:1",
      status: "connected" as const,
      createdAt: now,
      updatedAt: now,
    };
    const bare = toSocialAccount(accountRow);
    expect(Object.keys(bare).some((k) => /token|secret/i.test(k))).toBe(false);

    const enriched = toSocialAccount(accountRow, {
      socialAccountId: "acc-1",
      ciphertext: "SECRET_CT",
      iv: "SECRET_IV",
      scopes: ["w_member_social"],
      expiresAt: now,
      health: "valid",
      checkedAt: now,
      keyVersion: 2,
      createdAt: now,
      updatedAt: now,
    });
    expect(JSON.stringify(enriched)).not.toContain("SECRET_CT");
    expect(JSON.stringify(enriched)).not.toContain("SECRET_IV");
    expect(enriched).toMatchObject({
      hasToken: true,
      tokenHealth: "valid",
      tokenScopes: ["w_member_social"],
    });

    const sched = toSchedule({
      id: "s-1",
      contentId: "c-1",
      brandId: "b-1",
      platform: "linkedin",
      socialAccountId: "acc-1",
      versionId: "v-1",
      contentHash: "a".repeat(64),
      scheduledAt: now,
      status: "published",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:1/",
      delivery: "local",
      cloudSyncedAt: null,
      lastError: null,
      publishState: { phase: "done" },
      claimedAt: null,
      externalPostId: null,
      publishedAt: null,
      publishWarnings: null,
      detailsRev: 0,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(sched.permalink).toBe("https://www.linkedin.com/feed/update/urn:li:share:1/");
    // The local publisher's saved state stays inside the API.
    expect(Object.keys(sched)).not.toContain("publishState");

    const log = toPublishLog({
      id: "l-1",
      scheduleId: "s-1",
      attempt: 1,
      status: "succeeded",
      externalPostId: "urn:li:share:1",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:1/",
      error: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
    expect(log.permalink).toBe("https://www.linkedin.com/feed/update/urn:li:share:1/");
  });

  it("derives content status across single and multi-schedule publishing outcomes", () => {
    expect(deriveContentStatusAfterOutcome("scheduled", "publishing", [])).toBe("publishing");
    expect(deriveContentStatusAfterOutcome("publishing", "published", [])).toBe("published");
    expect(
      deriveContentStatusAfterOutcome("publishing", "published", [{ status: "pending" }]),
    ).toBe("scheduled");
    expect(
      deriveContentStatusAfterOutcome("publishing", "published", [{ status: "published" }]),
    ).toBe("published");
    expect(deriveContentStatusAfterOutcome("publishing", "failed", [])).toBe("failed");
    expect(deriveContentStatusAfterOutcome("publishing", "published", [{ status: "failed" }])).toBe(
      "failed",
    );
  });

  it("registers all new social-account and worker-schedule routes in OpenAPI 3.1 and enforces auth", async () => {
    const fakeEnv = { WORKER_TOKEN: "wtok-123", STUDIO_OWNER_SECRET: "owner-1" } as unknown as Env;
    const docRes = await app.fetch(
      new Request("http://127.0.0.1:8790/api/openapi.json", {
        headers: { "CF-Connecting-IP": "127.0.0.1", "X-Studio-Owner": "owner-1" },
      }),
      fakeEnv,
    );
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as { paths: Record<string, unknown> };
    for (const p of [
      "/api/social-accounts/{id}/token",
      "/api/social-accounts/{id}/check",
      "/api/social-accounts/meta/discover",
      "/api/social-accounts/linkedin/connect",
      "/api/worker/schedules/due",
      "/api/worker/schedules/{id}/credentials",
      "/api/worker/schedules/{id}/outcome",
    ]) {
      expect(doc.paths, p).toHaveProperty([p]);
    }

    // Non-local unauthenticated caller is rejected on requireLocal routes (401)
    const nonLocalRes = await app.fetch(
      new Request("http://127.0.0.1:8790/api/social-accounts/meta/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId: "b-1", userAccessToken: "12345678" }),
      }),
      fakeEnv,
    );
    expect(nonLocalRes.status).toBe(401);

    // Local caller without worker token is rejected on /api/worker/schedules/due (401)
    const noWorkerTokenRes = await app.fetch(
      new Request("http://127.0.0.1:8790/api/worker/schedules/due", {
        headers: { "CF-Connecting-IP": "127.0.0.1", "X-Studio-Owner": "owner-1" },
      }),
      fakeEnv,
    );
    expect(noWorkerTokenRes.status).toBe(401);
  });
});
