import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  LinkedInConnectInput,
  LinkedInOAuthInput,
  MetaDiscoverInput,
  MetaDiscoverResult,
  MetaExchangeInput,
  MetaExchangeResult,
  type Platform,
  SocialAccount,
  SocialAccountCheckInput,
  SocialAccountCreate,
  SocialAccountList,
  SocialAccountListQuery,
  SocialAccountTokenPut,
  SocialAccountUpdate,
  type TokenHealthStatus,
} from "@studio/contract";
import { and, count, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { toSocialAccount } from "../db/mappers.ts";
import { schedules, socialAccounts, socialAccountTokens } from "../db/schema.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import {
  discoverMetaPages,
  exchangeLinkedInCode,
  exchangeMetaCode,
  exchangeMetaLongLivedToken,
  inspectMetaTokenHealth,
  LINKEDIN_DEFAULT_EXPIRES_SECONDS,
  LINKEDIN_DEFAULT_SCOPES,
  linkedInApiBase,
  linkedInOAuthBase,
  META_FACEBOOK_ENGAGEMENT_SCOPES,
  META_FACEBOOK_SCOPES,
  META_INSTAGRAM_ENGAGEMENT_SCOPES,
  META_INSTAGRAM_SCOPES,
  META_LOGIN_SCOPES,
  metaGraphBase,
  readLinkedInMember,
  readMetaGrantedScopes,
} from "../lib/oauth.ts";
import { toPage } from "../lib/pagination.ts";
import { requestSyncStatement } from "../lib/publishing.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import {
  decryptAccountToken,
  encryptAccountToken,
  evaluateTokenHealth,
  VAULT_KEY_VERSION,
  type VaultEnv,
  vaultReady,
} from "../lib/token-vault.ts";
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
  health?: TokenHealthStatus;
}) {
  const { ciphertext, iv, keyVersion } = await encryptAccountToken(
    args.env,
    args.socialAccountId,
    args.accessToken,
  );
  const health = args.health ?? evaluateTokenHealth(args.expiresAt, args.now.getTime());
  await args.db.batch([
    args.db
      .insert(socialAccountTokens)
      .values({
        socialAccountId: args.socialAccountId,
        ciphertext,
        iv,
        keyVersion,
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
          keyVersion,
          scopes: args.scopes,
          expiresAt: args.expiresAt,
          health,
          checkedAt: args.now,
          updatedAt: args.now,
        },
      }),
    // Orders already at the cloud publisher carry the old token (sealed there): a cleared
    // `cloudSyncedAt` makes the worker push them again with this one, right away.
    args.db
      .update(schedules)
      .set({ cloudSyncedAt: null, updatedAt: args.now })
      .where(
        and(
          eq(schedules.socialAccountId, args.socialAccountId),
          eq(schedules.status, "pending"),
          eq(schedules.delivery, "cloud"),
        ),
      ),
    requestSyncStatement(args.db, args.now),
  ]);
  return health;
}

const migratedKeys = new Set<string>();

/**
 * Re-encrypt rows written with the pre-P3 vault secret under the per-install key.
 * Runs once per isolate and key; a row that cannot be read is marked `invalid`
 * (the owner reconnects the account) instead of being kept in the weak format.
 */
export async function migrateLegacyTokens(db: Db, env: VaultEnv): Promise<number> {
  const marker = env.TOKEN_ENCRYPTION_KEY ?? "";
  if (!vaultReady(env) || migratedKeys.has(marker)) return 0;
  const legacy = await db
    .select()
    .from(socialAccountTokens)
    .where(lt(socialAccountTokens.keyVersion, VAULT_KEY_VERSION));
  let migrated = 0;
  for (const row of legacy) {
    const now = new Date();
    try {
      const plaintext = await decryptAccountToken(env, row.socialAccountId, row);
      const sealed = await encryptAccountToken(env, row.socialAccountId, plaintext);
      await db
        .update(socialAccountTokens)
        .set({ ...sealed, updatedAt: now })
        .where(eq(socialAccountTokens.socialAccountId, row.socialAccountId));
      migrated++;
    } catch {
      await db.batch([
        db
          .update(socialAccountTokens)
          .set({ health: "invalid", checkedAt: now, updatedAt: now })
          .where(eq(socialAccountTokens.socialAccountId, row.socialAccountId)),
        db
          .update(socialAccounts)
          .set({ status: "needs_reauth", updatedAt: now })
          .where(eq(socialAccounts.id, row.socialAccountId)),
      ]);
    }
  }
  migratedKeys.add(marker);
  return migrated;
}

/** Decrypt an account's token (migrating legacy rows first). */
export async function readAccountToken(
  db: Db,
  env: VaultEnv,
  token: typeof socialAccountTokens.$inferSelect,
): Promise<string> {
  if (token.keyVersion < VAULT_KEY_VERSION && vaultReady(env)) {
    await migrateLegacyTokens(db, env);
    const fresh = await db.query.socialAccountTokens.findFirst({
      where: eq(socialAccountTokens.socialAccountId, token.socialAccountId),
    });
    if (fresh) return decryptAccountToken(env, fresh.socialAccountId, fresh);
  }
  return decryptAccountToken(env, token.socialAccountId, token);
}

function requiredScopesFor(platform: Platform): readonly string[] {
  if (platform === "instagram") return META_INSTAGRAM_SCOPES;
  if (platform === "facebook") return META_FACEBOOK_SCOPES;
  return ["w_member_social"];
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
router.use("/api/social-accounts/meta/exchange", requireLocal);
router.use("/api/social-accounts/linkedin/connect", requireLocal);
router.use("/api/social-accounts/linkedin/oauth", requireLocal);
router.use("/api/social-accounts/:id/token", requireLocal);
router.use("/api/social-accounts/:id/check", requireLocal);
router.use("/api/social-accounts/:id/disconnect", requireLocal);

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
      const baseUrl = metaGraphBase(c.env);
      let userToken = input.userAccessToken;
      let userExpiresAt: Date | null = input.userTokenExpiresAt
        ? new Date(input.userTokenExpiresAt)
        : null;

      if (appId && appSecret && input.userTokenExpiresAt === undefined) {
        const exchanged = await exchangeMetaLongLivedToken({
          appId,
          appSecret,
          shortLivedToken: input.userAccessToken,
          baseUrl,
        });
        userToken = exchanged.accessToken;
        userExpiresAt = exchanged.expiresAt;
      }

      const discovered = await discoverMetaPages({ userAccessToken: userToken, baseUrl });
      const connectedAccounts: SocialAccount[] = [];
      const selections = input.selections
        ? new Map(input.selections.map((s) => [s.pageId, s]))
        : null;
      // A Page token derived from a short-lived user token expires with it (~1-2 h);
      // one derived from a long-lived token does not expire.
      const pageExpiresAt =
        userExpiresAt && userExpiresAt.getTime() - Date.now() < 7 * 24 * 3600_000
          ? userExpiresAt
          : null;

      if (input.autoConnect) {
        for (const page of discovered) {
          const pick = selections
            ? selections.get(page.pageId)
            : { facebook: true, instagram: true };
          if (!pick) continue;
          if (!page.canPublish || !page.pageAccessToken) continue;
          if (pick.facebook !== false) {
            const fbAccount = await upsertPlatformAccount({
              db,
              env: c.env,
              brandId: input.brandId,
              platform: "facebook",
              externalId: page.pageId,
              handle: page.pageName,
              accessToken: page.pageAccessToken,
              expiresAt: pageExpiresAt,
              scopes: [...META_FACEBOOK_SCOPES, ...META_FACEBOOK_ENGAGEMENT_SCOPES],
              skipForeignBrand: true,
            });
            if (fbAccount) connectedAccounts.push(fbAccount);
          }

          if (page.instagram && pick.instagram !== false) {
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
              // Instagram publishes with the Page token (like the Facebook row above): it
              // expires only when that Page token does, not with the user token.
              accessToken: page.pageAccessToken,
              expiresAt: pageExpiresAt,
              scopes: [...META_INSTAGRAM_SCOPES, ...META_INSTAGRAM_ENGAGEMENT_SCOPES],
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
      summary: "Check token health (expiry, and with `live` the platform itself) (Mac only)",
      description:
        "Without `live`: expiry-based health. With `live`: Meta `debug_token` (needs the App " +
        "ID and secret from the Mac's Keychain; they are not stored) or LinkedIn `userinfo`. " +
        "An invalid token moves the account to `needs_reauth`.",
      request: {
        params: IdParams,
        body: {
          content: { "application/json": { schema: SocialAccountCheckInput } },
          required: false,
        },
      },
      responses: {
        200: json(SocialAccount, "Updated account with refreshed token health."),
        400: errors[400],
        403: forbidden,
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = SocialAccountCheckInput.parse((await c.req.json().catch(() => ({}))) ?? {});
      const db = createDb(c.env.DB);
      const { account, token } = await loadSocialAccountWithToken(db, id);
      if (!token) {
        return c.json(toSocialAccount(account, null), 200);
      }

      const now = new Date();
      let health: TokenHealthStatus = evaluateTokenHealth(token.expiresAt, now.getTime());
      let expiresAt = token.expiresAt;
      let scopes = token.scopes;

      if (input.live) {
        let plaintext: string | null = null;
        try {
          plaintext = await readAccountToken(db, c.env, token);
        } catch {
          health = "invalid";
        }
        if (plaintext && account.platform === "linkedin") {
          const member = await readLinkedInMember({
            accessToken: plaintext,
            apiBase: linkedInApiBase(c.env),
          });
          if (member === "invalid") health = "invalid";
        } else if (plaintext && input.appId && input.appSecret) {
          const live = await inspectMetaTokenHealth({
            token: plaintext,
            appId: input.appId,
            appSecret: input.appSecret,
            requiredScopes: requiredScopesFor(account.platform),
            targetId: account.externalId ?? undefined,
            baseUrl: metaGraphBase(c.env),
            now: now.getTime(),
          });
          if (live) {
            health = live.status;
            if (live.scopes.length) scopes = live.scopes;
            // Keep the earlier of what we knew and what Meta says.
            if (live.expiresAt && (!expiresAt || live.expiresAt < expiresAt)) {
              expiresAt = live.expiresAt;
            }
          }
        }
      }

      await db
        .update(socialAccountTokens)
        .set({ health, expiresAt, scopes, checkedAt: now, updatedAt: now })
        .where(eq(socialAccountTokens.socialAccountId, id));

      if (health === "invalid" && account.status !== "disabled") {
        await db
          .update(socialAccounts)
          .set({ status: "needs_reauth", updatedAt: now })
          .where(eq(socialAccounts.id, id));
      } else if (health !== "invalid" && account.status === "needs_reauth" && input.live) {
        await db
          .update(socialAccounts)
          .set({ status: "connected", updatedAt: now })
          .where(eq(socialAccounts.id, id));
      }

      const updated = await loadSocialAccountWithToken(db, id);
      return c.json(toSocialAccount(updated.account, updated.token), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts/{id}/disconnect",
      tags,
      summary: "Disconnect: delete the vaulted token and disable the account (Mac only)",
      description:
        "Refused (409) while the account has pending or publishing schedules. The account " +
        "row stays (history); connecting it again re-enables it.",
      request: { params: IdParams },
      responses: {
        200: json(SocialAccount, "Disconnected."),
        403: forbidden,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireSocialAccount(db, id);
      const [active] = await db
        .select({ n: count() })
        .from(schedules)
        .where(
          and(
            eq(schedules.socialAccountId, id),
            inArray(schedules.status, ["pending", "publishing"]),
          ),
        );
      if ((active?.n ?? 0) > 0) {
        throw conflict(
          `Bu hesapta bekleyen ${active?.n} zamanlama var; bağlantıyı kesmeden önce onları iptal edin.`,
        );
      }
      const now = new Date();
      await db.batch([
        db.delete(socialAccountTokens).where(eq(socialAccountTokens.socialAccountId, id)),
        db
          .update(socialAccounts)
          .set({ status: "disabled", updatedAt: now })
          .where(eq(socialAccounts.id, id)),
      ]);
      const updated = await loadSocialAccountWithToken(db, id);
      return c.json(toSocialAccount(updated.account, updated.token), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts/meta/exchange",
      tags,
      summary: "Finish Facebook Login: code/token -> (long-lived) user token + Pages (Mac only)",
      description:
        "With `code` (+ `appSecret`, `redirectUri`) exchanges the authorization code, then for a " +
        "~60-day token. With an implicit-flow `accessToken` and `appSecret` exchanges it for a " +
        "long-lived one; without the secret the short-lived token is returned as is. Lists the " +
        "Pages (without their tokens) so the owner can pick which to connect.",
      request: { body: jsonBody(MetaExchangeInput) },
      responses: {
        200: json(MetaExchangeResult, "User token and the Pages it manages."),
        400: errors[400],
        403: forbidden,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const baseUrl = metaGraphBase(c.env);
      let token: string;
      let expiresAt: Date | null = null;
      if (input.code) {
        const exchanged = await exchangeMetaCode({
          appId: input.appId,
          appSecret: input.appSecret as string,
          code: input.code,
          redirectUri: input.redirectUri as string,
          baseUrl,
        });
        token = exchanged.accessToken;
        expiresAt = exchanged.expiresAt;
      } else {
        token = input.accessToken as string;
      }
      let longLived = false;
      if (input.appSecret) {
        const exchanged = await exchangeMetaLongLivedToken({
          appId: input.appId,
          appSecret: input.appSecret,
          shortLivedToken: token,
          baseUrl,
        });
        token = exchanged.accessToken;
        expiresAt = exchanged.expiresAt;
        longLived = true;
      } else if (!expiresAt) {
        // Implicit-flow tokens live 1-2 hours; assume the shorter.
        expiresAt = new Date(Date.now() + 3600_000);
      }
      const granted = await readMetaGrantedScopes({ userAccessToken: token, baseUrl });
      const pages = await discoverMetaPages({ userAccessToken: token, baseUrl });
      const required = META_LOGIN_SCOPES.filter((s) => s !== "business_management");
      return c.json(
        {
          userAccessToken: token,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          longLived,
          grantedScopes: granted ?? [],
          missingScopes: granted ? required.filter((s) => !granted.includes(s)) : [],
          pages: pages.map(({ pageAccessToken: _omit, ...rest }) => rest),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts/linkedin/oauth",
      tags,
      summary:
        "Finish LinkedIn OAuth: exchange the code, read the member, vault the token (Mac only)",
      request: { body: jsonBody(LinkedInOAuthInput) },
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
      const exchanged = await exchangeLinkedInCode({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        code: input.code,
        redirectUri: input.redirectUri,
        oauthBase: linkedInOAuthBase(c.env),
        apiBase: linkedInApiBase(c.env),
      });
      const connected = await upsertPlatformAccount({
        db,
        env: c.env,
        brandId: input.brandId,
        platform: "linkedin",
        externalId: exchanged.personUrn,
        handle: exchanged.name,
        accessToken: exchanged.accessToken,
        expiresAt: new Date(Date.now() + exchanged.expiresInSeconds * 1000),
        scopes: exchanged.scopes,
      });
      if (!connected) throw new Error("failed to connect LinkedIn account");
      return c.json(connected, 200);
    },
  );
