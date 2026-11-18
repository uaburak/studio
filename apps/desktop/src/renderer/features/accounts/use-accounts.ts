// The connect flows' state from the main process (`window.studio.accounts`), the owner's app
// credentials, and a browser stand-in (gallery, headless checks: connecting needs the app).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  AccountsBridge,
  AccountsState,
  PublishingApps,
  SystemBridge,
} from "../../../shared/accounts-ipc.ts";
import { bridge } from "../../lib/bridge.ts";
import { queryKeys } from "../../state/studio.tsx";

const ONLY_IN_APP = "Hesap bağlama yalnızca Studio uygulamasında çalışır.";

export function createBrowserAccounts(): AccountsBridge {
  let state: AccountsState = { phase: { kind: "idle" }, busyAccountIds: [], revision: 0 };
  const listeners = new Set<(s: AccountsState) => void>();
  const set = (next: AccountsState) => {
    state = next;
    for (const l of listeners) l(state);
  };
  const apps: PublishingApps = {
    meta: { appId: "", hasSecret: false },
    linkedIn: { clientId: "", hasSecret: false },
  };
  const fail = async () => set({ ...state, phase: { kind: "failed", message: ONLY_IN_APP } });
  return {
    state: async () => state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apps: async () => apps,
    saveMetaApp: async () => ({ ok: false, message: ONLY_IN_APP }),
    saveLinkedInApp: async () => ({ ok: false, message: ONLY_IN_APP }),
    forgetMetaSecret: async () => apps,
    connectMeta: fail,
    connectLinkedIn: fail,
    confirmMeta: async () => undefined,
    cancel: async () => set({ ...state, phase: { kind: "idle" } }),
    dismiss: async () => set({ ...state, phase: { kind: "idle" } }),
    check: fail,
    disconnect: fail,
  };
}

let browserAccounts: AccountsBridge | undefined;

export function accountsBridge(): AccountsBridge {
  const own = bridge().accounts;
  if (own) return own;
  browserAccounts ??= createBrowserAccounts();
  return browserAccounts;
}

export function systemBridge(): SystemBridge | null {
  return bridge().system ?? null;
}

const IDLE: AccountsState = { phase: { kind: "idle" }, busyAccountIds: [], revision: 0 };

/** Live flow state; refetches the accounts list whenever the main process changed one. */
export function useAccountsFlow(): AccountsState {
  const [state, setState] = useState<AccountsState>(IDLE);
  const queryClient = useQueryClient();
  const revision = useRef<number | null>(null);
  useEffect(() => {
    const b = accountsBridge();
    let alive = true;
    const apply = (next: AccountsState) => {
      if (!alive) return;
      if (revision.current !== null && next.revision !== revision.current) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      }
      revision.current = next.revision;
      setState(next);
    };
    void b.state().then(apply);
    const off = b.onChange(apply);
    return () => {
      alive = false;
      off();
    };
  }, [queryClient]);
  return state;
}

export const appsKey = ["publishing-apps"] as const;

export function usePublishingApps() {
  return useQuery({
    queryKey: appsKey,
    queryFn: () => accountsBridge().apps(),
    staleTime: 60_000,
  });
}
