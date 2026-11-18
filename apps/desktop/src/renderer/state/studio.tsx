// Root providers and hooks: host status, settings, the API client, server data (react-query),
// the live job feed and open conversations.
import type {
  ApiClient,
  Brand,
  Conversation,
  ConversationList,
  Job,
  SocialAccount,
} from "@studio/contract";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DesktopSettings, HostSnapshot, SettingsPatch } from "../../shared/ipc.ts";
import { ApiContext, createStudioClient, useApi } from "../lib/api.ts";
import { bridge, fallbackSettings } from "../lib/bridge.ts";
import { type AgentChoice, choiceFor, saveChoicePatch } from "../lib/models.ts";
import { jobTitle } from "../lib/usage.ts";
import { sessionOf, useAppStore } from "./app-store.ts";
import {
  ConversationCache,
  ConversationController,
  type ConversationSnapshot,
} from "./conversation.ts";
import { finishedNotice, JobsController, type JobsSnapshot } from "./jobs.ts";

// --- host & settings ------------------------------------------------------------------------------

const HostContext = createContext<HostSnapshot | null>(null);

interface SettingsValue {
  settings: DesktopSettings;
  update(patch: SettingsPatch): void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function useHost(): HostSnapshot | null {
  return useContext(HostContext);
}

export function isHostUp(host: HostSnapshot | null): boolean {
  return host?.status.kind === "running" || host?.status.kind === "attached";
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("SettingsContext missing");
  return value;
}

/** The settings, or null outside the app's providers (the editor demo, component tests). */
export function useOptionalSettings(): SettingsValue | null {
  return useContext(SettingsContext);
}

// --- live controllers ---------------------------------------------------------------------------

interface LiveValue {
  jobs: JobsController;
  conversations: ConversationCache;
}

const LiveContext = createContext<LiveValue | null>(null);

function useLive(): LiveValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error("LiveContext missing");
  return value;
}

export function useJobs(): JobsSnapshot & { controller: JobsController } {
  const { jobs } = useLive();
  const snapshot = useSyncExternalStore(jobs.subscribe, jobs.getSnapshot);
  return { ...snapshot, controller: jobs };
}

const NO_JOBS: JobsSnapshot = { jobs: [], presence: null, status: "closed" };
const noSubscribe = () => () => undefined;
const noJobs = () => NO_JOBS;

/**
 * The live job list, or an empty one outside the app's providers (parts that are also rendered
 * on their own, e.g. the post detail's Kontroller in component tests).
 */
export function useJobList(): readonly Job[] {
  const live = useContext(LiveContext);
  return useSyncExternalStore(live?.jobs.subscribe ?? noSubscribe, live?.jobs.getSnapshot ?? noJobs)
    .jobs;
}

/** The live jobs and the Mac's presence, or an empty feed outside the app's providers. */
export function useJobsSnapshot(): JobsSnapshot {
  const live = useContext(LiveContext);
  return useSyncExternalStore(
    live?.jobs.subscribe ?? noSubscribe,
    live?.jobs.getSnapshot ?? noJobs,
  );
}

/** The app's open conversations, or null outside its providers (they make their own). */
export function useConversationCache(): ConversationCache | null {
  return useContext(LiveContext)?.conversations ?? null;
}

export function useConversationController(id: string): ConversationController {
  const { conversations } = useLive();
  return useMemo(() => conversations.get(id), [conversations, id]);
}

export function useConversation(
  id: string,
): ConversationSnapshot & { controller: ConversationController } {
  const controller = useConversationController(id);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { ...snapshot, controller };
}

/** Model / effort for a conversation (null: a new chat), saved per conversation. */
export function useAgentChoice(
  conversationId: string | null,
): [AgentChoice, (c: AgentChoice) => void] {
  const { settings, update } = useSettings();
  const choice = choiceFor(settings, conversationId);
  return [choice, (next) => update(saveChoicePatch(next, conversationId))];
}

// --- server data ------------------------------------------------------------------------------------

export const queryKeys = {
  brands: ["brands"] as const,
  conversations: ["conversations"] as const,
  accounts: ["accounts"] as const,
};

export function useBrands() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: queryKeys.brands,
    queryFn: async (): Promise<Brand[]> => (await api.brands.list({ limit: 100 })).items,
    enabled: up,
    staleTime: 30_000,
  });
}

export function useConversations() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: queryKeys.conversations,
    queryFn: async (): Promise<Conversation[]> => {
      const items: Conversation[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const list: ConversationList = await api.conversations.list({
          status: "active",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...list.items);
        if (!list.nextCursor) break;
        cursor = list.nextCursor;
      }
      return items;
    },
    enabled: up,
    refetchInterval: 20_000,
  });
}

export function useAccounts() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: async (): Promise<SocialAccount[]> =>
      (await api.socialAccounts.list({ limit: 100 })).items,
    enabled: up,
    staleTime: 60_000,
  });
}

/** Put a changed conversation into the cached list (title, activity, active run). */
export function useConversationUpdater(): (conversation: Conversation) => void {
  const queryClient = useQueryClient();
  return (conversation) => {
    queryClient.setQueryData<Conversation[]>(queryKeys.conversations, (list) => {
      if (!list) return list;
      const index = list.findIndex((c) => c.id === conversation.id);
      if (conversation.status === "archived") return list.filter((c) => c.id !== conversation.id);
      if (index === -1) return [conversation, ...list];
      const next = [...list];
      next[index] = conversation;
      return next;
    });
  };
}

// --- provider ---------------------------------------------------------------------------------------

function useBridgeState() {
  const [host, setHost] = useState<HostSnapshot | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  useEffect(() => {
    const b = bridge();
    let alive = true;
    void b.host.get().then((h) => alive && setHost(h));
    void b.settings.get().then((s) => {
      if (!alive) return;
      setSettings(s);
      useAppStore.getState().restore(s.session);
    });
    const offHost = b.host.onChange(setHost);
    const offSettings = b.settings.onChange(setSettings);
    const offWindow = b.onWindowState((state) => useAppStore.getState().setWindowState(state));
    return () => {
      alive = false;
      offHost();
      offSettings();
      offWindow();
    };
  }, []);
  return { host, settings, setSettings };
}

/** Saves the window session (sidebar, panel, route, brand) shortly after it changes. */
function useSessionPersistence(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = JSON.stringify(sessionOf(useAppStore.getState()));
    const off = useAppStore.subscribe((state) => {
      const next = JSON.stringify(sessionOf(state));
      if (next === last) return;
      last = next;
      clearTimeout(timer);
      timer = setTimeout(
        () => void bridge().settings.update({ session: sessionOf(useAppStore.getState()) }),
        400,
      );
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [ready]);
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const { host, settings, setSettings } = useBridgeState();
  const portRef = useRef<number | null>(null);
  portRef.current = host?.apiPort ?? null;
  const client = useMemo<ApiClient>(() => createStudioClient(() => portRef.current), []);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
      }),
    [],
  );
  const settingsRef = useRef<DesktopSettings>(settings ?? fallbackSettings());
  if (settings) settingsRef.current = settings;
  const live = useMemo<LiveValue>(() => {
    const jobs = new JobsController(client);
    const conversations = new ConversationCache(
      (id) =>
        new ConversationController(id, client, {
          choice: () => choiceFor(settingsRef.current, id),
          saveChoice: (choice) => void bridge().settings.update(saveChoicePatch(choice, id)),
          onConversation: (conversation) => {
            queryClient.setQueryData<Conversation[]>(queryKeys.conversations, (list) =>
              list?.map((c) => (c.id === conversation.id ? conversation : c)),
            );
          },
        }),
    );
    jobs.onJobChange = (job, previous) => {
      if (job.type === "chat.turn")
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      if (previous && previous.status !== job.status) {
        const conversationId = (job.payload as { conversationId?: unknown }).conversationId;
        const title =
          job.type === "chat.turn"
            ? (queryClient
                .getQueryData<Conversation[]>(queryKeys.conversations)
                ?.find((c) => c.id === conversationId)?.title ?? "Studio")
            : jobTitle(job);
        const notice = finishedNotice(job, title);
        if (notice && !useAppStore.getState().window.focused) void bridge().notify(notice);
      }
    };
    return { jobs, conversations };
  }, [client, queryClient]);

  const up = isHostUp(host);
  useEffect(() => {
    if (!up) return;
    live.jobs.start();
    void queryClient.invalidateQueries();
    return () => {
      live.jobs.stop();
      live.conversations.clear();
    };
  }, [up, live, queryClient]);

  useSessionPersistence(settings !== null);

  const settingsValue = useMemo<SettingsValue | null>(
    () =>
      settings
        ? {
            settings,
            update: (patch) => {
              void bridge()
                .settings.update(patch)
                .then((next) => setSettings(next));
            },
          }
        : null,
    [settings, setSettings],
  );

  if (!settingsValue) return null;
  return (
    <HostContext.Provider value={host}>
      <SettingsContext.Provider value={settingsValue}>
        <ApiContext.Provider value={client}>
          <QueryClientProvider client={queryClient}>
            <LiveContext.Provider value={live}>{children}</LiveContext.Provider>
          </QueryClientProvider>
        </ApiContext.Provider>
      </SettingsContext.Provider>
    </HostContext.Provider>
  );
}
