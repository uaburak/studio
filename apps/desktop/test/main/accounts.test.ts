import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MetaDiscoverInput,
  MetaExchangeInput,
  MetaExchangeResult,
  SocialAccount,
} from "@studio/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsApi } from "../../src/main/accounts/api.ts";
import { AppIdsStore, validateMetaAppId } from "../../src/main/accounts/apps-store.ts";
import { validateTunnelToken } from "../../src/main/accounts/ipc.ts";
import { LoopbackError, waitForCallback } from "../../src/main/accounts/loopback.ts";
import {
  callbackParams,
  linkedInAuthorizeUrl,
  metaAuthorizeUrl,
  newState,
  OAuthCallbackError,
  parseLinkedInCallback,
  parseMetaCallback,
} from "../../src/main/accounts/oauth.ts";
import {
  type Cipher,
  FileSecretStore,
  MemorySecretStore,
} from "../../src/main/accounts/secrets.ts";
import { AccountsService } from "../../src/main/accounts/service.ts";
import type { AccountsState } from "../../src/shared/accounts-ipc.ts";

const T = "2026-11-17T10:00:00.000Z";

function account(over: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "a1",
    brandId: "b1",
    platform: "instagram",
    handle: "mtmagro",
    externalId: "ig1",
    status: "connected",
    createdAt: T,
    updatedAt: T,
    hasToken: true,
    tokenHealth: "valid",
    tokenExpiresAt: null,
    ...over,
  };
}

/** GET http://127.0.0.1:<port><path> → {status, body}. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// --- OAuth URLs and callbacks -----------------------------------------------------------------

describe("oauth helpers", () => {
  it("builds the Meta login URL: code flow with an App Secret, token flow without", () => {
    const withSecret = new URL(metaAuthorizeUrl("123", "s1", true));
    expect(withSecret.origin + withSecret.pathname).toBe(
      "https://www.facebook.com/v27.0/dialog/oauth",
    );
    expect(withSecret.searchParams.get("client_id")).toBe("123");
    expect(withSecret.searchParams.get("redirect_uri")).toBe("http://localhost:8793/meta/callback");
    expect(withSecret.searchParams.get("state")).toBe("s1");
    expect(withSecret.searchParams.get("response_type")).toBe("code");
    expect(withSecret.searchParams.get("scope")).toContain("instagram_content_publish");
    expect(new URL(metaAuthorizeUrl("123", "s1", false)).searchParams.get("response_type")).toBe(
      "token",
    );
  });

  it("builds the LinkedIn login URL", () => {
    const url = new URL(linkedInAuthorizeUrl("cid", "s2"));
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8793/linkedin/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("checks the state and reads code / fragment token / errors", () => {
    expect(parseMetaCallback("http://localhost:8793/meta/callback?code=abc&state=s", "s")).toEqual({
      code: "abc",
    });
    expect(
      parseMetaCallback(
        "http://localhost:8793/meta/callback?access_token=tok12345&expires_in=3600&state=s",
        "s",
      ),
    ).toEqual({ accessToken: "tok12345", expiresIn: 3600 });
    expect(callbackParams("http://x/cb?a=1#b=2&a=3")).toEqual({ a: "3", b: "2" });
    expect(() => parseMetaCallback("http://x/cb?code=abc&state=other", "s")).toThrow(
      OAuthCallbackError,
    );
    expect(() => parseMetaCallback("http://x/cb?code=abc&state=other", "s")).toThrow(
      "bu oturuma ait değil",
    );
    expect(() =>
      parseMetaCallback("http://x/cb?error=access_denied&error_description=Kapatıldı", "s"),
    ).toThrow("Giriş tamamlanmadı: Kapatıldı");
    expect(() => parseMetaCallback("http://x/cb?state=s", "s")).toThrow("yetki kodu yok");
    expect(parseLinkedInCallback("http://x/cb?code=li&state=s", "s")).toBe("li");
    expect(() => parseLinkedInCallback("http://x/cb?code=li", "s")).toThrow("bu oturuma ait değil");
  });

  it("makes random 32-hex states", () => {
    const a = newState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newState()).not.toBe(a);
  });
});

// --- loopback listener ----------------------------------------------------------------------------

describe("loopback listener", () => {
  it("answers the callback with a page and resolves with the full URL", async () => {
    let port = 0;
    const done = waitForCallback("/meta/callback", {
      port: 0,
      hosts: ["127.0.0.1"],
      closeDelayMs: 0,
      onReady: (p) => {
        port = p;
      },
    });
    await vi.waitFor(() => expect(port).toBeGreaterThan(0));
    expect((await get(port, "/other?code=1")).status).toBe(404);
    const fragment = await get(port, "/meta/callback");
    expect(fragment.status).toBe(200);
    expect(fragment.body).toContain("location.hash");
    const ok = await get(port, "/meta/callback?code=abc&state=s1");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("Studio’ya iletildi");
    const url = await done;
    expect(url.pathname).toBe("/meta/callback");
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("s1");
  });

  it("fails with port_busy when the port is in use", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const busy = typeof address === "object" && address ? address.port : 0;
    try {
      const error = await waitForCallback("/meta/callback", {
        port: busy,
        hosts: ["127.0.0.1"],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LoopbackError);
      expect((error as LoopbackError).reason).toBe("port_busy");
      expect((error as Error).message).toContain(`${busy} portu açılamadı`);
    } finally {
      blocker.close();
    }
  });

  it("stops on abort and on timeout", async () => {
    const controller = new AbortController();
    const waiting = waitForCallback("/x", {
      port: 0,
      hosts: ["127.0.0.1"],
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "cancelled" });
    await expect(
      waitForCallback("/x", { port: 0, hosts: ["127.0.0.1"], timeoutMs: 20 }),
    ).rejects.toMatchObject({ reason: "timed_out" });
  });
});

// --- connect flows ---------------------------------------------------------------------------------

function exchangeResult(over: Partial<MetaExchangeResult> = {}): MetaExchangeResult {
  return {
    userAccessToken: "USER-TOKEN-SECRET",
    expiresAt: "2027-01-16T10:00:00.000Z",
    longLived: true,
    grantedScopes: [],
    missingScopes: [],
    pages: [
      {
        pageId: "p1",
        pageName: "MTM Agro",
        canPublish: true,
        pageAccessToken: "PAGE-TOKEN-SECRET",
        instagram: { igUserId: "ig1", username: "mtmagro" },
      },
      {
        pageId: "p2",
        pageName: "Partner",
        canPublish: false,
        instagram: null,
      },
    ],
    ...over,
  };
}

function fakeApi(over: Partial<AccountsApi> = {}): AccountsApi & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls[name] = args;
      return value;
    };
  return {
    calls,
    listAccounts: record("listAccounts", [account({ externalId: "ig1" })]),
    exchangeMeta: record("exchangeMeta", exchangeResult()),
    discoverMeta: record("discoverMeta", {
      pages: [],
      connectedAccounts: [
        account({ handle: "mtmagro" }),
        account({ id: "a2", platform: "facebook", handle: "MTM Agro" }),
      ],
    }),
    linkedInOAuth: record("linkedInOAuth", account({ platform: "linkedin", handle: "Burak Koç" })),
    checkAccount: record("checkAccount", account({ tokenHealth: "expiring_soon" })),
    disconnectAccount: record("disconnectAccount", account({ status: "disabled" })),
    ...over,
  } as AccountsApi & { calls: Record<string, unknown[]> };
}

function makeService(options: {
  api?: AccountsApi;
  secrets?: MemorySecretStore;
  ids?: { metaAppId: string; linkedInClientId: string };
  redirect?: (authorizeUrl: string) => string;
}) {
  const opened: string[] = [];
  const ids = { metaAppId: "123", linkedInClientId: "cid", ...options.ids };
  const states: AccountsState[] = [];
  const service = new AccountsService({
    api: options.api ?? fakeApi(),
    secrets:
      options.secrets ??
      new MemorySecretStore({
        "meta-app-secret": "APPSECRET",
        "linkedin-client-secret": "LISECRET",
      }),
    ids: { get: async () => ids, set: async (p) => Object.assign(ids, p) },
    openExternal: (url) => {
      opened.push(url);
    },
    newState: () => "STATE",
    waitForCallback: async (_path, { onReady, signal }) => {
      onReady();
      if (signal.aborted) throw new LoopbackError("cancelled", 8793);
      const authorize = opened.at(-1) ?? "";
      return new URL(
        options.redirect?.(authorize) ?? "http://localhost:8793/cb?code=CODE&state=STATE",
      );
    },
  });
  service.onChange((s) => states.push(s));
  return { service, opened, states };
}

describe("AccountsService", () => {
  it("Meta: opens the login page, exchanges the code with the App Secret, offers the Pages", async () => {
    const api = fakeApi();
    const { service, opened } = makeService({ api });
    await service.runMetaConnect("b1");
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0] as string).searchParams.get("response_type")).toBe("code");
    expect(api.calls.exchangeMeta?.[0]).toEqual({
      appId: "123",
      appSecret: "APPSECRET",
      code: "CODE",
      redirectUri: "http://localhost:8793/meta/callback",
    } satisfies MetaExchangeInput);
    const phase = service.state().phase;
    expect(phase.kind).toBe("picking");
    if (phase.kind !== "picking") return;
    // No token reaches the renderer's state.
    expect(JSON.stringify(service.state())).not.toContain("TOKEN-SECRET");
    expect(phase.pages[0]).toEqual({
      pageId: "p1",
      pageName: "MTM Agro",
      canPublish: true,
      instagram: { igUserId: "ig1", username: "mtmagro" },
    });
    // Already connected Instagram is preselected; Pages without publish rights are left out.
    expect(phase.initial).toEqual([{ pageId: "p1", facebook: false, instagram: true }]);
  });

  it("Meta: confirming vaults the picked accounts with the user token kept in main", async () => {
    const api = fakeApi();
    const { service } = makeService({ api });
    await service.runMetaConnect("b1");
    await service.confirmMeta([{ pageId: "p1", facebook: true, instagram: true }]);
    expect(api.calls.discoverMeta?.[0]).toEqual({
      brandId: "b1",
      userAccessToken: "USER-TOKEN-SECRET",
      autoConnect: true,
      selections: [{ pageId: "p1", facebook: true, instagram: true }],
      userTokenExpiresAt: "2027-01-16T10:00:00.000Z",
    } satisfies MetaDiscoverInput);
    expect(service.state().phase).toEqual({
      kind: "finished",
      message: "Bağlandı: Instagram · mtmagro, Facebook · MTM Agro.",
    });
    expect(service.state().revision).toBe(1);
  });

  it("Meta: a redirect with someone else's state is refused (no exchange)", async () => {
    const api = fakeApi();
    const { service } = makeService({
      api,
      redirect: () => "http://localhost:8793/meta/callback?code=CODE&state=EVIL",
    });
    await service.runMetaConnect("b1");
    expect(api.calls.exchangeMeta).toBeUndefined();
    expect(service.state().phase).toEqual({
      kind: "failed",
      message: "Giriş yanıtı bu oturuma ait değil; yeniden deneyin.",
    });
  });

  it("Meta without an App Secret uses the token flow and says the link is short-lived", async () => {
    const api = fakeApi({
      exchangeMeta: async (input) => {
        api.calls.exchangeMeta = [input];
        return exchangeResult({ longLived: false });
      },
    });
    const { service, opened } = makeService({
      api,
      secrets: new MemorySecretStore(),
      redirect: () => "http://localhost:8793/meta/callback?access_token=SHORT12345&state=STATE",
    });
    await service.runMetaConnect("b1");
    expect(new URL(opened[0] as string).searchParams.get("response_type")).toBe("token");
    expect(api.calls.exchangeMeta?.[0]).toEqual({ appId: "123", accessToken: "SHORT12345" });
    await service.confirmMeta([{ pageId: "p1", facebook: true, instagram: false }]);
    const phase = service.state().phase;
    expect(phase.kind === "finished" && phase.message).toContain("yaklaşık bir saat");
  });

  it("asks for the app first and reports a busy port", async () => {
    const { service } = makeService({ ids: { metaAppId: "", linkedInClientId: "" } });
    await service.runMetaConnect("b1");
    expect(service.state().phase).toMatchObject({ kind: "failed" });
    await service.runLinkedInConnect("b1");
    expect(service.state().phase).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("LinkedIn uygulamasının"),
    });

    const busy = new AccountsService({
      api: fakeApi(),
      secrets: new MemorySecretStore(),
      ids: {
        get: async () => ({ metaAppId: "1", linkedInClientId: "" }),
        set: async (p) => ({ metaAppId: "1", linkedInClientId: "", ...p }),
      },
      openExternal: () => undefined,
      waitForCallback: async () => {
        throw new LoopbackError("port_busy", 8793);
      },
    });
    await busy.runMetaConnect("b1");
    expect(busy.state().phase).toEqual({
      kind: "failed",
      message: "Giriş dönüşü için 8793 portu açılamadı (başka bir uygulama kullanıyor olabilir).",
    });
  });

  it("LinkedIn: exchanges the code through the API with the Client Secret", async () => {
    const api = fakeApi();
    const { service } = makeService({ api });
    await service.runLinkedInConnect("b1");
    expect(api.calls.linkedInOAuth?.[0]).toEqual({
      brandId: "b1",
      clientId: "cid",
      clientSecret: "LISECRET",
      code: "CODE",
      redirectUri: "http://localhost:8793/linkedin/callback",
    });
    expect(service.state().phase).toEqual({
      kind: "finished",
      message: "LinkedIn bağlandı: Burak Koç. Anahtar 60 gün geçerli; bitmeden hatırlatılır.",
    });
  });

  it("cancel returns to idle and drops the exchange", async () => {
    const { service } = makeService({});
    await service.runMetaConnect("b1");
    service.cancel();
    expect(service.state().phase).toEqual({ kind: "idle" });
    await service.confirmMeta([{ pageId: "p1", facebook: true, instagram: true }]);
    expect(service.state().phase).toEqual({ kind: "idle" });
  });

  it("check asks live with the Meta app; a result never replaces the picker", async () => {
    const api = fakeApi();
    const { service } = makeService({ api });
    await service.check({ id: "a1", platform: "instagram" });
    expect(api.calls.checkAccount).toEqual([
      "a1",
      { live: true, appId: "123", appSecret: "APPSECRET" },
    ]);
    expect(service.state().phase).toEqual({
      kind: "finished",
      message: "mtmagro: Yakında doluyor.",
    });
    expect(service.state().busyAccountIds).toEqual([]);

    await service.runMetaConnect("b1");
    await service.disconnect("a1");
    expect(api.calls.disconnectAccount).toEqual(["a1"]);
    expect(service.state().phase.kind).toBe("picking");
  });

  it("saves app ids (Meta: digits only) and secrets without returning them", async () => {
    const secrets = new MemorySecretStore();
    const { service } = makeService({ secrets, ids: { metaAppId: "", linkedInClientId: "" } });
    const bad = await service.saveMetaApp({ appId: "abc" });
    expect(bad).toEqual({ ok: false, message: "Uygulama Kimliği yalnızca rakamlardan oluşur." });
    const ok = await service.saveMetaApp({ appId: " 555 ", secret: " S3CRET " });
    expect(ok).toEqual({
      ok: true,
      value: {
        meta: { appId: "555", hasSecret: true },
        linkedIn: { clientId: "", hasSecret: false },
      },
    });
    expect(secrets.values.get("meta-app-secret")).toBe("S3CRET");
    const forgotten = await service.forgetMetaSecret();
    expect(forgotten.meta.hasSecret).toBe(false);
  });
});

// --- storage ------------------------------------------------------------------------------------------

describe("secret and id storage", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "studio-accounts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cipher: Cipher = {
    available: () => true,
    encrypt: (text) => Buffer.from([...Buffer.from(text)].reverse()),
    decrypt: (data) => Buffer.from([...data].reverse()).toString(),
  };

  it("keeps secrets encrypted in a 0600 file, falls back to the AppKit Keychain until removed", async () => {
    const appKit = { has: vi.fn(async () => true), load: vi.fn(async () => "FROM-APPKIT") };
    const file = join(dir, "desktop-secrets.json");
    const store = new FileSecretStore(file, cipher, appKit);
    expect(await store.load("meta-app-secret")).toBe("FROM-APPKIT");
    await store.save("meta-app-secret", "OWN-SECRET");
    expect(readFileSync(file, "utf8")).not.toContain("OWN-SECRET");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.load("meta-app-secret")).toBe("OWN-SECRET");
    await store.delete("meta-app-secret");
    expect(await store.has("meta-app-secret")).toBe(false);
    expect(await store.load("meta-app-secret")).toBeNull();
    // Another name still reads the AppKit copy.
    expect(await store.has("linkedin-client-secret")).toBe(true);
  });

  it("refuses to save when encryption is unavailable", async () => {
    const store = new FileSecretStore(join(dir, "s.json"), { ...cipher, available: () => false });
    await expect(store.save("cloudflare-tunnel-token", "x".repeat(40))).rejects.toThrow(
      "şifreli saklama",
    );
  });

  it("stores app ids and imports the AppKit defaults until saved", async () => {
    const run = vi.fn(async (_file: string, args: string[]) =>
      args[2] === "studio.meta.appId" ? { code: 0, stdout: "777\n" } : { code: 1, stdout: "" },
    );
    const store = new AppIdsStore(join(dir, "ids.json"), run);
    expect(await store.get()).toEqual({ metaAppId: "777", linkedInClientId: "" });
    await store.set({ linkedInClientId: "abc" });
    expect(await new AppIdsStore(join(dir, "ids.json"), null).get()).toEqual({
      metaAppId: "777",
      linkedInClientId: "abc",
    });
    expect(validateMetaAppId(" 12 ")).toBe("12");
  });

  it("validates a tunnel token before saving", () => {
    expect(() => validateTunnelToken("short")).toThrow("geçersiz");
    expect(() => validateTunnelToken(`${"a".repeat(40)} b`)).toThrow("geçersiz");
    expect(validateTunnelToken(` ${"e".repeat(64)} `)).toBe("e".repeat(64));
  });
});
