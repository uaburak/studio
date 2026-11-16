import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  LinkedInConnectInput,
  MetaDiscoverInput,
  MetaDiscoverResult,
  type Platform,
  SocialAccount,
  SocialAccountCreate,
  SocialAccountList,
  SocialAccountListQuery,
  SocialAccountTokenPut,
  SocialAccountUpdate,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { toSocialAccount } from "../db/mappers.ts";
import { socialAccounts, socialAccountTokens } from "../db/schema.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import {
  discoverMetaPages,
  exchangeMetaLongLivedToken,
  LINKEDIN_DEFAULT_EXPIRES_SECONDS,
  LINKEDIN_DEFAULT_SCOPES,
  META_FACEBOOK_SCOPES,
  META_INSTAGRAM_SCOPES,
} from "../lib/oauth.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { encryptAccountToken, evaluateTokenHealth, type VaultEnv } from "../lib/token-vault.ts";
import { requireLocal } from "../middleware/access.ts";
import { requireBrand } from "./brands.ts";

const tags = ["Social accounts"];
const forbidden = json(ApiErrorBody, "Not called from the Mac itself (`forbidden`).");

export async function requireSocialAccount(db: Db, id: string) {
  const row = await db.query.socialAccounts.findFirst({ where: eq(socialAccounts.id, id) });
  if (!row) throw notFound("social account", id);
  return row;
}

export async function loadSocialAccountWithToken(db: Db, id: string) {
  const [found] = await db
    .select({ account: socialAccounts, token: socialAccountTokens })
    .from(socialAccounts)
    .leftJoin(socialAccountTokens, eq(socialAccounts.id, socialAccountTokens.socialAccountId))
    .where(eq(socialAccounts.id, id));
  if (!found) throw notFound("social account", id);
  return found;
}

async function saveEncryptedToken(args: {
  db: Db;
  env: VaultEnv;
  socialAccountId: string;
  accessToken: string;
  expiresAt: Date | null;
  scopes: string[];
  now: Date;
}) {
  const { ciphertext, iv } = await encryptAccountToken(
    args.env,
    args.socialAccountId,
    args.accessToken,
  );
  const health = evaluateTokenHealth(args.expiresAt, args.now.getTime());
  await args.db
    .insert(socialAccountTokens)
    .values({
      socialAccountId: args.socialAccountId,
      ciphertext,
      iv,
      scopes: args.scopes,
      expiresAt: args.expiresAt,
      health,
      checkedAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: socialAccountTokens.socialAccountId,
      set: {
        ciphertext,
        iv,
        scopes: args.scopes,
        expiresAt: args.expiresAt,
        health,
        checkedAt: args.now,
        updatedAt: args.now,
      },
    });
  return health;
}

async function upsertPlatformAccount(args: {
  db: Db;
  env: VaultEnv;
  brandId: string;
  platform: Platform;
  externalId: string;
  handle: string;
  accessToken: string;
  expiresAt: Date | null;
  scopes: string[];
  skipForeignBrand?: boolean;
}): Promise<SocialAccount | null> {
  const now = new Date();
  const existing = await args.db.query.socialAccounts.findFirst({
    where: and(
      eq(socialAccounts.platform, args.platform),
      eq(socialAccounts.externalId, args.externalId),
    ),
  });

  let accountId: string;
  if (existing) {
    if (existing.brandId !== args.brandId) {
      if (args.skipForeignBrand) return null;
      throw conflict(
        `${args.platform} account ${args.externalId} is already connected to another brand`,
      );
    }
    accountId = existing.id;
    await args.db
      .update(socialAccounts)
      .set({
        handle: args.handle,
        status: "connected",
        updatedAt: now,
      })
      .where(eq(socialAccounts.id, accountId));
  } else {
    accountId = newId();
    await args.db.insert(socialAccounts).values({
      id: accountId,
      brandId: args.brandId,
      platform: args.platform,
      handle: args.handle,
      externalId: args.externalId,
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
  }

  await saveEncryptedToken({
    db: args.db,
    env: args.env,
    socialAccountId: accountId,
    accessToken: args.accessToken,
    expiresAt: args.expiresAt,
    scopes: args.scopes,
    now,
  });

  const loaded = await loadSocialAccountWithToken(args.db, accountId);
  return toSocialAccount(loaded.account, loaded.token);
}

const router = createRouter();

router.use("/api/social-accounts/meta/discover", requireLocal);
router.use("/api/social-accounts/linkedin/connect", requireLocal);
router.use("/api/social-accounts/:id/token", requireLocal);

export const socialAccountRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/api/social-accounts",
      tags,
      summary: "List social accounts (newest first, with token health)",
      request: { query: SocialAccountListQuery },
      responses: { 200: json(SocialAccountList, "A page of accounts."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, platform, status } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(socialAccounts.brandId, brandId));
      if (platform) where.push(eq(socialAccounts.platform, platform));
      if (status) where.push(eq(socialAccounts.status, status));
      if (cursor) where.push(lt(socialAccounts.id, cursor));
      const rows = await createDb(c.env.DB)
        .select({ account: socialAccounts, token: socialAccountTokens })
        .from(socialAccounts)
        .leftJoin(socialAccountTokens, eq(socialAccounts.id, socialAccountTokens.socialAccountId))
        .where(and(...where))
        .orderBy(desc(socialAccounts.id))
        .limit(limit + 1);
      return c.json(
        toPage(
          rows,
          limit,
          (r) => toSocialAccount(r.account, r.token),
          (r) => r.account.id,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts",
      tags,
      summary: "Register a social account for a brand",
      description:
        "Stores metadata only; attach credentials via PUT /api/social-accounts/{id}/token.",
      request: { body: jsonBody(SocialAccountCreate) },
      responses: {
        201: json(SocialAccount, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, input.brandId);
      const now = new Date();
      const [row] = await db
        .insert(socialAccounts)
        .values({
          id: newId(),
          brandId: input.brandId,
          platform: input.platform,
          handle: input.handle,
          externalId: input.externalId ?? null,
          status: input.status,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toSocialAccount(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts/meta/discover",
      tags,
      summary: "Discover Meta Pages and linked Instagram accounts (Mac only)",
      description:
        "Optionally exchanges a short-lived user token for a long-lived one, lists Managed Pages " +
        "and linked Instagram professional accounts, and vaults credentials when `autoConnect` is true.",
      request: { body: jsonBody(MetaDiscoverInput) },
      responses: {
        200: json(MetaDiscoverResult, "Discovered Pages and connected accounts."),
        400: errors[400],
        403: forbidden,
        404: errors[404],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, input.brandId);

      const appId = input.appId ?? c.env.META_APP_ID;
      const appSecret = input.appSecret ?? c.env.META_APP_SECRET;
      let userToken = input.userAccessToken;
      let userExpiresAt: Date | null = null;

      if (appId && appSecret) {
        const exchanged = await exchangeMetaLongLivedToken({
          appId,
          appSecret,
          shortLivedToken: input.userAccessToken,
        });
        userToken = exchanged.accessToken;
        userExpiresAt = exchanged.expiresAt;
      }

      const discovered = await discoverMetaPages({ userAccessToken: userToken });
      const connectedAccounts: SocialAccount[] = [];

      if (input.autoConnect) {
        for (const page of discovered) {
          if (!page.canPublish || !page.pageAccessToken) continue;
          const fbAccount = await upsertPlatformAccount({
            db,
            env: c.env,
            brandId: input.brandId,
            platform: "facebook",
            externalId: page.pageId,
            handle: page.pageName,
            accessToken: page.pageAccessToken,
            expiresAt: null,
            scopes: [...META_FACEBOOK_SCOPES],
            skipForeignBrand: true,
          });
          if (fbAccount) connectedAccounts.push(fbAccount);

          if (page.instagram) {
            const igHandle = page.instagram.username.startsWith("@")
              ? page.instagram.username
              : `@${page.instagram.username}`;
            const igAccount = await upsertPlatformAccount({
              db,
              env: c.env,
              brandId: input.brandId,
              platform: "instagram",
              externalId: page.instagram.igUserId,
              handle: igHandle,
              accessToken: page.pageAccessToken,
              expiresAt: userExpiresAt,
              scopes: [...META_INSTAGRAM_SCOPES],
              skipForeignBrand: true,
            });
            if (igAccount) connectedAccounts.push(igAccount);
          }
        }
      }

      const sanitizedPages = discovered.map(({ pageAccessToken: _omit, ...rest }) => rest);
      return c.json({ pages: sanitizedPages, connectedAccounts }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts/linkedin/connect",
      tags,
      summary: "Connect a LinkedIn profile/organization and vault its OAuth token (Mac only)",
      request: { body: jsonBody(LinkedInConnectInput) },
      responses: {
        200: json(SocialAccount, "Connected."),
        400: errors[400],
        403: forbidden,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, input.brandId);

      const ttlSeconds = input.expiresInSeconds ?? LINKEDIN_DEFAULT_EXPIRES_SECONDS;
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const connected = await upsertPlatformAccount({
        db,
        env: c.env,
        brandId: input.brandId,
        platform: "linkedin",
        externalId: input.personUrn,
        handle: input.handle,
        accessToken: input.accessToken,
        expiresAt,
        scopes: [...LINKEDIN_DEFAULT_SCOPES],
      });
      if (!connected) throw new Error("failed to connect LinkedIn account");
      return c.json(connected, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/social-accounts/{id}",
      tags,
      summary: "Get a social account (with token health)",
      request: { params: IdParams },
      responses: { 200: json(SocialAccount, "The account."), 404: errors[404] },
    }),
    async (c) => {
      const { account, token } = await loadSocialAccountWithToken(
        createDb(c.env.DB),
        c.req.valid("param").id,
      );
      return c.json(toSocialAccount(account, token), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/social-accounts/{id}",
      tags,
      summary: "Update a social account",
      description: "Accounts are not deleted (schedules reference them); set `status: disabled`.",
      request: { params: IdParams, body: jsonBody(SocialAccountUpdate) },
      responses: {
        200: json(SocialAccount, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireSocialAccount(db, id);
      const [row] = await db
        .update(socialAccounts)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(socialAccounts.id, id))
        .returning();
      if (!row) throw notFound("social account", id);
      return c.json(toSocialAccount(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/social-accounts/{id}/token",
      tags,
      summary: "Encrypt and store a social account access token (Mac only)",
      request: { params: IdParams, body: jsonBody(SocialAccountTokenPut) },
      responses: {
        200: json(SocialAccount, "Token stored and account marked connected."),
        400: errors[400],
        403: forbidden,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireSocialAccount(db, id);

      const now = new Date();
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      await saveEncryptedToken({
        db,
        env: c.env,
        socialAccountId: id,
        accessToken: input.accessToken,
        expiresAt,
        scopes: input.scopes ?? [],
        now,
      });

      await db
        .update(socialAccounts)
        .set({
          status: "connected",
          ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
          ...(input.handle !== undefined ? { handle: input.handle } : {}),
          updatedAt: now,
        })
        .where(eq(socialAccounts.id, id));

      const { account, token } = await loadSocialAccountWithToken(db, id);
      return c.json(toSocialAccount(account, token), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts/{id}/check",
      tags,
      summary: "Check stored token expiry and refresh health status",
      request: { params: IdParams },
      responses: {
        200: json(SocialAccount, "Updated account with refreshed token health."),
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const { account, token } = await loadSocialAccountWithToken(db, id);
      if (!token) {
        return c.json(toSocialAccount(account, null), 200);
      }

      const now = new Date();
      const health = evaluateTokenHealth(token.expiresAt, now.getTime());
      await db
        .update(socialAccountTokens)
        .set({ health, checkedAt: now, updatedAt: now })
        .where(eq(socialAccountTokens.socialAccountId, id));

      if (health === "invalid" && account.status !== "disabled") {
        await db
          .update(socialAccounts)
          .set({ status: "needs_reauth", updatedAt: now })
          .where(eq(socialAccounts.id, id));
      }

      const updated = await loadSocialAccountWithToken(db, id);
      return c.json(toSocialAccount(updated.account, updated.token), 200);
    },
  );
