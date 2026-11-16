import type {
  ApiClient,
  Brand,
  Content,
  ContentVersion,
  Schedule,
  SocialAccount,
} from "@studio/contract";
import { computeContentHash } from "@studio/contract";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import { AppProviders, createQueryClient, routes } from "../src/App.tsx";

const empty = () => Promise.resolve({ items: [] as never[], nextCursor: null });
const notMocked = (name: string) => () => Promise.reject(new Error(`${name} not mocked`));

type C = ApiClient;

/** Typed vi.fn()s for the endpoints the UI uses: lists are empty, everything else rejects. */
export function createMockApi() {
  return {
    health: vi.fn<C["health"]>(() =>
      Promise.resolve({
        status: "ok" as const,
        service: "studio-api" as const,
        version: "0.0.0",
        time: "2026-11-16T10:00:00.000Z",
        checks: { db: "ok" as const },
      }),
    ),
    brands: {
      list: vi.fn<C["brands"]["list"]>(empty),
      get: vi.fn<C["brands"]["get"]>(notMocked("brands.get")),
      create: vi.fn<C["brands"]["create"]>(notMocked("brands.create")),
      update: vi.fn<C["brands"]["update"]>(notMocked("brands.update")),
    },
    brandProfiles: {
      list: vi.fn<C["brandProfiles"]["list"]>(empty),
      current: vi.fn<C["brandProfiles"]["current"]>(notMocked("brandProfiles.current")),
      get: vi.fn<C["brandProfiles"]["get"]>(notMocked("brandProfiles.get")),
      create: vi.fn<C["brandProfiles"]["create"]>(notMocked("brandProfiles.create")),
      update: vi.fn<C["brandProfiles"]["update"]>(notMocked("brandProfiles.update")),
      approve: vi.fn<C["brandProfiles"]["approve"]>(notMocked("brandProfiles.approve")),
    },
    socialAccounts: {
      list: vi.fn<C["socialAccounts"]["list"]>(empty),
      get: vi.fn<C["socialAccounts"]["get"]>(notMocked("socialAccounts.get")),
      create: vi.fn<C["socialAccounts"]["create"]>(notMocked("socialAccounts.create")),
      update: vi.fn<C["socialAccounts"]["update"]>(notMocked("socialAccounts.update")),
      putToken: vi.fn<C["socialAccounts"]["putToken"]>(notMocked("socialAccounts.putToken")),
      checkToken: vi.fn<C["socialAccounts"]["checkToken"]>(notMocked("socialAccounts.checkToken")),
      discoverMeta: vi.fn<C["socialAccounts"]["discoverMeta"]>(
        notMocked("socialAccounts.discoverMeta"),
      ),
      connectLinkedIn: vi.fn<C["socialAccounts"]["connectLinkedIn"]>(
        notMocked("socialAccounts.connectLinkedIn"),
      ),
    },
    assets: {
      list: vi.fn<C["assets"]["list"]>(empty),
      get: vi.fn<C["assets"]["get"]>(notMocked("assets.get")),
      upload: vi.fn<C["assets"]["upload"]>(notMocked("assets.upload")),
      contentUrl: (id: string) => `/api/assets/${id}/content`,
    },
    contents: {
      list: vi.fn<C["contents"]["list"]>(empty),
      get: vi.fn<C["contents"]["get"]>(notMocked("contents.get")),
      create: vi.fn<C["contents"]["create"]>(notMocked("contents.create")),
      update: vi.fn<C["contents"]["update"]>(notMocked("contents.update")),
      delete: vi.fn<C["contents"]["delete"]>(notMocked("contents.delete")),
      approve: vi.fn<C["contents"]["approve"]>(notMocked("contents.approve")),
      transition: vi.fn<C["contents"]["transition"]>(notMocked("contents.transition")),
      versions: {
        list: vi.fn<C["contents"]["versions"]["list"]>(empty),
        get: vi.fn<C["contents"]["versions"]["get"]>(notMocked("versions.get")),
        create: vi.fn<C["contents"]["versions"]["create"]>(notMocked("versions.create")),
        update: vi.fn<C["contents"]["versions"]["update"]>(notMocked("versions.update")),
      },
    },
    jobs: {
      list: vi.fn<C["jobs"]["list"]>(empty),
      get: vi.fn<C["jobs"]["get"]>(notMocked("jobs.get")),
      create: vi.fn<C["jobs"]["create"]>(notMocked("jobs.create")),
      cancel: vi.fn<C["jobs"]["cancel"]>(notMocked("jobs.cancel")),
      streamUrl: vi.fn<C["jobs"]["streamUrl"]>(() => "ws://localhost/api/jobs/stream"),
      watch: vi.fn<C["jobs"]["watch"]>((_query, handlers) => {
        handlers.onStatus?.("closed");
        return { close: vi.fn() };
      }),
    },
    workers: {
      presence: vi.fn<C["workers"]["presence"]>(notMocked("workers.presence")),
      claude: vi.fn<C["workers"]["claude"]>(notMocked("workers.claude")),
      claudeLogin: vi.fn<C["workers"]["claudeLogin"]>(notMocked("workers.claudeLogin")),
      claudeRefresh: vi.fn<C["workers"]["claudeRefresh"]>(notMocked("workers.claudeRefresh")),
      gemini: vi.fn<C["workers"]["gemini"]>(notMocked("workers.gemini")),
      geminiRefresh: vi.fn<C["workers"]["geminiRefresh"]>(notMocked("workers.geminiRefresh")),
    },
    schedules: {
      list: vi.fn<C["schedules"]["list"]>(empty),
      get: vi.fn<C["schedules"]["get"]>(notMocked("schedules.get")),
      create: vi.fn<C["schedules"]["create"]>(notMocked("schedules.create")),
      cancel: vi.fn<C["schedules"]["cancel"]>(notMocked("schedules.cancel")),
      logs: vi.fn<C["schedules"]["logs"]>(empty),
    },
    conversations: {
      list: vi.fn<C["conversations"]["list"]>(empty),
      get: vi.fn<C["conversations"]["get"]>(notMocked("conversations.get")),
      create: vi.fn<C["conversations"]["create"]>(notMocked("conversations.create")),
      update: vi.fn<C["conversations"]["update"]>(notMocked("conversations.update")),
      messages: {
        list: vi.fn<C["conversations"]["messages"]["list"]>(empty),
        send: vi.fn<C["conversations"]["messages"]["send"]>(notMocked("messages.send")),
        answer: vi.fn<C["conversations"]["messages"]["answer"]>(notMocked("messages.answer")),
        consent: vi.fn<C["conversations"]["messages"]["consent"]>(notMocked("messages.consent")),
      },
      aliases: {
        list: vi.fn<C["conversations"]["aliases"]["list"]>(() => Promise.resolve({ items: [] })),
        rename: vi.fn<C["conversations"]["aliases"]["rename"]>(notMocked("aliases.rename")),
      },
      runs: vi.fn<C["conversations"]["runs"]>(empty),
      streamUrl: vi.fn<C["conversations"]["streamUrl"]>(
        (id) => `ws://localhost/api/conversations/${id}/stream`,
      ),
      watch: vi.fn<C["conversations"]["watch"]>((_id, handlers) => {
        handlers.onStatus?.("closed");
        return { close: vi.fn(), lastSeq: undefined };
      }),
    },
    agentRuns: {
      get: vi.fn<C["agentRuns"]["get"]>(notMocked("agentRuns.get")),
      cancel: vi.fn<C["agentRuns"]["cancel"]>(notMocked("agentRuns.cancel")),
    },
    plans: {
      list: vi.fn<C["plans"]["list"]>(empty),
      get: vi.fn<C["plans"]["get"]>(notMocked("plans.get")),
      update: vi.fn<C["plans"]["update"]>(notMocked("plans.update")),
      accept: vi.fn<C["plans"]["accept"]>(notMocked("plans.accept")),
      reject: vi.fn<C["plans"]["reject"]>(notMocked("plans.reject")),
      generate: vi.fn<C["plans"]["generate"]>(notMocked("plans.generate")),
    },
  };
}

export type MockApi = ReturnType<typeof createMockApi>;

export function renderRoute(path: string, api: MockApi) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  const utils = render(
    <AppProviders
      // Covers every endpoint the UI calls; newer contract additions stay unmocked.
      api={api as unknown as ApiClient}
      queryClient={queryClient}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router, queryClient };
}

// --- Fixtures ----------------------------------------------------------------

const T = "2026-11-16T10:00:00.000Z";

export const brand = (patch: Partial<Brand> = {}): Brand => ({
  id: "brand-1",
  name: "MTM Agro",
  slug: "mtm-agro",
  defaultLanguage: "tr",
  status: "active",
  createdAt: T,
  updatedAt: T,
  ...patch,
});

export const account = (patch: Partial<SocialAccount> = {}): SocialAccount => ({
  id: "acc-1",
  brandId: "brand-1",
  platform: "instagram",
  handle: "@mtmagro",
  externalId: null,
  status: "pending",
  createdAt: T,
  updatedAt: T,
  ...patch,
});

export const SLIDES = [
  {
    html: '<!doctype html><html><head><title>1</title></head><body style="margin:0;width:1080px;height:1350px;background:#df4325"><h1>Bir</h1></body></html>',
    width: 1080,
    height: 1350,
  },
  {
    html: '<!doctype html><html><head><title>2</title></head><body style="margin:0;width:1080px;height:1350px;background:#1b1a17"><h1>İki</h1></body></html>',
    width: 1080,
    height: 1350,
  },
];

export async function versionFixture(patch: Partial<ContentVersion> = {}): Promise<ContentVersion> {
  const contentHash = await computeContentHash(SLIDES);
  return {
    id: "ver-1",
    contentId: "content-1",
    version: 1,
    origin: "generated",
    contentHash,
    slideCount: SLIDES.length,
    note: null,
    jobId: null,
    createdAt: T,
    updatedAt: T,
    slides: SLIDES.map((s) => ({ ...s, renderedAssetId: null })),
    ...patch,
  };
}

export const contentFixture = (patch: Partial<Content> = {}): Content => ({
  id: "content-1",
  brandId: "brand-1",
  type: "carousel",
  title: "Kasım kampanyası",
  brief: "Yeni tohum serisi",
  status: "draft",
  targetPlatforms: ["instagram"],
  caption: "",
  currentVersion: null,
  approval: null,
  createdAt: T,
  updatedAt: T,
  ...patch,
});

export const scheduleFixture = (patch: Partial<Schedule> = {}): Schedule => ({
  id: "sch-1",
  contentId: "content-1",
  brandId: "brand-1",
  platform: "instagram",
  socialAccountId: "acc-1",
  versionId: "ver-1",
  contentHash: "a".repeat(64),
  scheduledAt: "2030-01-15T06:30:00.000Z",
  status: "pending",
  cancelledAt: null,
  createdAt: T,
  updatedAt: T,
  ...patch,
});

export const page = <T,>(items: T[]) => Promise.resolve({ items, nextCursor: null });
