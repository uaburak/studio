import type { HostSettingsPendingChange } from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  applyHostChange,
  buildHostState,
  HostSettingsBridge,
  type HostSettingsPorts,
} from "../../src/main/host-settings-bridge.ts";
import { applyPatch, defaultSettings, type SettingsStore } from "../../src/main/settings.ts";
import type { HostSnapshot } from "../../src/shared/ipc.ts";

function memorySettings() {
  let value = defaultSettings("/repo");
  return {
    get: () => value,
    update: (patch: Parameters<SettingsStore["update"]>[0]) => {
      value = applyPatch(value, patch);
    },
  };
}

function fakes() {
  const settings = memorySettings();
  const env = new Map<string, string>();
  const secrets = new Map<string, string>();
  const ids = { metaAppId: "", linkedInClientId: "" };
  let login = false;
  const snapshot: HostSnapshot = {
    status: { kind: "running" },
    apiPort: 8790,
    lanPort: 8791,
    instance: "mac-1",
    lanUrls: ["http://192.168.1.2:8791"],
    tunnelUrl: null,
    tunnelNote: null,
    services: { api: { kind: "running", pid: 1 } },
    ownsChildren: true,
  };
  const ports: HostSettingsPorts = {
    settings,
    host: {
      snapshot: () => snapshot,
      macName: () => "Burak's Mac",
      tunnel: () => ({ state: "off", detail: "Kapalı." }),
    },
    loginItem: {
      get: () => ({ supported: true, enabled: login, needsApproval: false, note: "ok" }),
      set: (on) => {
        login = on;
        return { supported: true, enabled: login, needsApproval: false, note: "ok" };
      },
    },
    keepAwake: () => ({ active: false, reason: null }),
    workerEnv: {
      summary: () => ({
        entries: [...env.keys()].map((name) => ({ name, source: "settings" as const })),
        sealed: true,
      }),
      set: (name, value) => env.set(name, value),
      remove: (name) => env.delete(name),
      editable: [
        { name: "GEMINI_API_KEY", label: "Gemini", secret: true },
        { name: "ELEVENLABS_API_KEY", label: "ElevenLabs", secret: true },
      ],
    },
    accounts: {
      apps: async () => ({
        meta: { appId: ids.metaAppId, hasSecret: secrets.has("meta") },
        linkedIn: { clientId: ids.linkedInClientId, hasSecret: secrets.has("linkedin") },
      }),
      saveMetaApp: async ({ appId, secret }) => {
        if (!/^\d*$/.test(appId)) return { ok: false, message: "rakam" };
        ids.metaAppId = appId;
        if (secret) secrets.set("meta", secret);
        return { ok: true };
      },
      saveLinkedInApp: async ({ clientId, secret }) => {
        ids.linkedInClientId = clientId;
        if (secret) secrets.set("linkedin", secret);
        return { ok: true };
      },
      forgetMetaSecret: async () => secrets.delete("meta"),
      forgetLinkedInSecret: async () => {
        secrets.delete("linkedin");
      },
    },
    tunnelToken: {
      has: async () => secrets.has("tunnel"),
      save: async (value) => {
        if (value.length < 32) throw new Error("Tünel anahtarı geçersiz görünüyor");
        secrets.set("tunnel", value);
      },
      remove: async () => {
        secrets.delete("tunnel");
      },
    },
    appVersion: "1.2.3",
    mode: "dev",
    updatesNote: "elle",
  };
  return { ports, settings, env, secrets, ids, login: () => login };
}

const change = (
  values: HostSettingsPendingChange["values"],
  keys: HostSettingsPendingChange["keys"] = [],
): HostSettingsPendingChange => ({
  id: "c1",
  values,
  keys,
  createdAt: new Date().toISOString(),
});

describe("host settings bridge: state", () => {
  it("reports values and which keys are saved, never their values", async () => {
    const f = fakes();
    f.env.set("ELEVENLABS_API_KEY", "sk_secret_value");
    const state = await buildHostState(f.ports);
    expect(state.values).toMatchObject({ lanEnabled: true, keepAwake: true, defaultModel: null });
    expect(state.info).toMatchObject({ macName: "Burak's Mac", apiPort: 8790, hostError: false });
    expect(state.keys.find((k) => k.name === "ELEVENLABS_API_KEY")).toMatchObject({
      saved: true,
      source: "settings",
    });
    expect(state.keys.find((k) => k.name === "CLOUDFLARE_TUNNEL_TOKEN")?.saved).toBe(false);
    expect(JSON.stringify(state)).not.toContain("sk_secret_value");
  });
});

describe("host settings bridge: applying a change", () => {
  it("writes settings, the default chat choice and the login item", async () => {
    const f = fakes();
    const out = await applyHostChange(
      change({ keepAwake: false, appearance: "dark", defaultModel: "opus", loginItem: true }),
      f.ports,
    );
    expect(out.result.ok).toBe(true);
    expect(out.restart).toBeNull();
    expect(f.settings.get()).toMatchObject({ keepAwake: false, appearance: "dark" });
    expect(f.settings.get().agent.last).toEqual({ model: "opus", effort: "medium" });
    expect(f.login()).toBe(true);
  });

  it("asks for a host restart only when local network or remote access really changed", async () => {
    const f = fakes();
    expect((await applyHostChange(change({ lanEnabled: true }), f.ports)).restart).toBeNull();
    const off = await applyHostChange(change({ remoteControlEnabled: true }), f.ports);
    expect(off.restart).toBe("host");
    expect(f.settings.get().remoteControlEnabled).toBe(true);
  });

  it("stores keys where they belong and restarts the tunnel for its token", async () => {
    const f = fakes();
    const out = await applyHostChange(
      change({ metaAppId: "1688" }, [
        { name: "ELEVENLABS_API_KEY", value: "sk_eleven" },
        { name: "CLOUDFLARE_TUNNEL_TOKEN", value: "t".repeat(40) },
        { name: "META_APP_SECRET", value: "meta-secret" },
      ]),
      f.ports,
    );
    expect(out.result.ok).toBe(true);
    expect(out.restart).toBe("tunnel");
    expect(f.env.get("ELEVENLABS_API_KEY")).toBe("sk_eleven");
    expect(f.secrets.get("tunnel")).toBe("t".repeat(40));
    expect(f.secrets.get("meta")).toBe("meta-secret");
    expect(f.ids.metaAppId).toBe("1688");
    expect(out.result.message).toContain("yeniden başlayınca");

    const removed = await applyHostChange(
      change({}, [
        { name: "ELEVENLABS_API_KEY", value: null },
        { name: "META_APP_SECRET", value: null },
      ]),
      f.ports,
    );
    expect(removed.result.ok).toBe(true);
    expect(f.env.has("ELEVENLABS_API_KEY")).toBe(false);
    expect(f.secrets.has("meta")).toBe(false);
  });

  it("reports what failed in Turkish", async () => {
    const f = fakes();
    const out = await applyHostChange(
      change({}, [{ name: "CLOUDFLARE_TUNNEL_TOKEN", value: "short" }]),
      f.ports,
    );
    expect(out.result.ok).toBe(false);
    expect(out.result.message).toContain("Tünel anahtarı");
  });
});

describe("host settings bridge: sync loop", () => {
  it("applies pending changes, reports them before restarting, and never applies twice", async () => {
    const f = fakes();
    const bodies: { results: { id: string; ok: boolean }[] }[] = [];
    let served = false;
    const events: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      events.push(`sync:${body.results.length}`);
      const pending =
        !served && body.results.length === 0
          ? [
              {
                id: "c1",
                values: { lanEnabled: false },
                keys: [],
                createdAt: new Date().toISOString(),
              },
            ]
          : [];
      served = served || pending.length > 0;
      return new Response(JSON.stringify({ pending }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const bridge = new HostSettingsBridge({
      ports: f.ports,
      target: () => ({ port: 8790, ownerSecret: "owner" }),
      restartHost: () => events.push("restart:host"),
      restartTunnel: () => events.push("restart:tunnel"),
      fetch: fakeFetch,
    });
    await bridge.sync();
    expect(f.settings.get().lanEnabled).toBe(false);
    expect(events).toEqual(["sync:0", "sync:1", "restart:host"]);
    expect(bodies[1]?.results[0]).toMatchObject({ id: "c1", ok: true });
    await bridge.sync();
    expect(events.at(-1)).toBe("sync:0");
  });

  it("stays quiet while the host is down", async () => {
    const f = fakes();
    let calls = 0;
    const bridge = new HostSettingsBridge({
      ports: f.ports,
      target: () => null,
      restartHost: () => undefined,
      restartTunnel: () => undefined,
      fetch: (async () => {
        calls++;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await bridge.sync();
    expect(calls).toBe(0);
  });
});
