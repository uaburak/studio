// The few API calls of the connect flows, made from the main process straight to the local API
// (127.0.0.1 counts as the Mac itself, which these "Mac only" routes require). Paths and bodies
// follow packages/contract (social-account.ts); only types are imported, so the main bundle does
// not pull in the contract package at runtime.
import type {
  LinkedInOAuthInput,
  MetaDiscoverInput,
  MetaDiscoverResult,
  MetaExchangeInput,
  MetaExchangeResult,
  SocialAccount,
  SocialAccountCheckInput,
  SocialAccountList,
} from "@studio/contract";

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export interface AccountsApi {
  listAccounts(brandId: string): Promise<SocialAccount[]>;
  exchangeMeta(input: MetaExchangeInput): Promise<MetaExchangeResult>;
  discoverMeta(input: MetaDiscoverInput): Promise<MetaDiscoverResult>;
  linkedInOAuth(input: LinkedInOAuthInput): Promise<SocialAccount>;
  checkAccount(id: string, input: SocialAccountCheckInput): Promise<SocialAccount>;
  disconnectAccount(id: string): Promise<SocialAccount>;
}

type Fetch = typeof fetch;

export function createAccountsApi(port: () => number | null, doFetch: Fetch = fetch): AccountsApi {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const p = port();
    if (p === null) throw new ApiFailure("Studio sunucusu hazır değil.", 503);
    let res: Response;
    try {
      res = await doFetch(`http://127.0.0.1:${p}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiFailure("Studio sunucusuna ulaşılamadı.", 0);
    }
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiFailure(error?.message ?? `HTTP ${res.status}`, res.status, error?.code);
    }
    return json as T;
  }
  const enc = encodeURIComponent;
  return {
    listAccounts: async (brandId) =>
      (
        await call<SocialAccountList>(
          "GET",
          `/api/social-accounts?brandId=${enc(brandId)}&limit=100`,
        )
      ).items,
    exchangeMeta: (input) => call("POST", "/api/social-accounts/meta/exchange", input),
    discoverMeta: (input) => call("POST", "/api/social-accounts/meta/discover", input),
    linkedInOAuth: (input) => call("POST", "/api/social-accounts/linkedin/oauth", input),
    checkAccount: (id, input) => call("POST", `/api/social-accounts/${enc(id)}/check`, input),
    disconnectAccount: (id) => call("POST", `/api/social-accounts/${enc(id)}/disconnect`),
  };
}
