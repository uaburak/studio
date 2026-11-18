// The app's real providers (StudioProvider) over a fake local API: `fetch` answers from a small
// route table and WebSockets are recorded, so tests can push stream frames and move the host
// up and down.
import type { Brand } from "@studio/contract";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { createFallbackBridge, setBridge } from "../../src/renderer/lib/bridge.ts";
import { StudioProvider } from "../../src/renderer/state/studio.tsx";
import type { HostSnapshot, StudioBridge } from "../../src/shared/ipc.ts";
import { T } from "./fixtures.ts";

export class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  push(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  /** The server went away. */
  drop() {
    this.close();
  }
  static find(part: string, from = 0): FakeSocket | undefined {
    return FakeSocket.all.slice(from).find((s) => s.url.includes(part) && s.readyState !== 3);
  }
}

export type Reply = unknown | { status: number; body: unknown };
export type Route = (method: string, path: string, body: unknown) => Reply | undefined;

export const brand = (id: string, name: string, over: Partial<Brand> = {}): Brand => ({
  id,
  name,
  slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-x`,
  defaultLanguage: "tr",
  status: "active",
  createdAt: T,
  updatedAt: T,
  ...over,
});

export const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });

export function apiError(status: number, code: string, message: string) {
  return { status, body: { error: { code, message } } };
}

const running: HostSnapshot = {
  status: { kind: "running" },
  apiPort: 8790,
  lanPort: null,
  instance: "i",
  lanUrls: [],
  tunnelUrl: null,
  tunnelNote: null,
  services: {},
  ownsChildren: true,
};

/** Renders `ui` in the app's providers; `route` answers the API (undefined: an empty page). */
export function renderLive(ui: ReactNode, route: Route = () => undefined) {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://studio.test");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : init?.body instanceof FormData
          ? Object.fromEntries(init.body.entries())
          : undefined;
    const path = `${url.pathname}${url.search}`;
    calls.push({ method, path, body });
    const reply = route(method, path, body) ?? (method === "GET" ? page([]) : {});
    const shaped =
      reply && typeof reply === "object" && "status" in reply && "body" in reply
        ? (reply as { status: number; body: unknown })
        : { status: 200, body: reply };
    return new Response(JSON.stringify(shaped.body), {
      status: shaped.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  let host = running;
  const hostListeners = new Set<(s: HostSnapshot) => void>();
  const base = createFallbackBridge();
  const bridge: StudioBridge = {
    ...base,
    host: {
      get: async () => host,
      restart: async () => undefined,
      onChange: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    },
  };
  setBridge(bridge);
  const view = render(<StudioProvider>{ui}</StudioProvider>);
  return {
    ...view,
    calls,
    fetch: fetchMock,
    bridge,
    setHost(next: Partial<HostSnapshot> | "down" | "up") {
      host =
        next === "down"
          ? { ...running, status: { kind: "stopped" }, apiPort: null }
          : next === "up"
            ? running
            : { ...host, ...next };
      for (const l of hostListeners) l(host);
    },
  };
}

export function resetLive() {
  setBridge(undefined);
  vi.unstubAllGlobals();
  FakeSocket.all = [];
}
