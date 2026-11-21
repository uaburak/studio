import { env, exports } from "cloudflare:workers";
import type {
  ApiErrorBody,
  HostSettingsChange,
  HostSettingsState,
  HostSettingsSyncResult,
  HostSettingsView,
  PairingCode,
  PairingResult,
} from "@studio/contract";
import { HOST_LOCKOUT_MESSAGES } from "@studio/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE, LOCAL } from "./helpers.ts";

/*
 * The Mac host settings bridge (iOS Ayarlar): the Mac app syncs its state and takes queued
 * changes; a paired phone reads the state and queues changes; the lockout guard refuses changes
 * that would cut the phone's own route.
 */

let n = 0;
const lan = () => ({
  "CF-Connecting-IP": `192.168.50.${(n++ % 200) + 1}`,
  "X-Studio-Gateway": "1",
});
const tunnel = () => ({
  "CF-Connecting-IP": "203.0.113.7",
  "X-Studio-Gateway": "1",
  "CF-Ray": "8a1b2c3d4e5f-IST",
});
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function call<T = unknown>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const res = await exports.default.fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  return { status: res.status, body: parsed as T };
}

async function pairPhone(): Promise<string> {
  const offer = await call<PairingCode>("POST", "/api/pairing/codes", LOCAL);
  const claim = await call<PairingResult>("POST", "/api/pairing/claim", lan(), {
    code: offer.body.code,
    deviceName: "Test iPhone",
    platform: "ios",
  });
  expect(claim.status, JSON.stringify(claim.body)).toBe(201);
  return claim.body.token;
}

function state(overrides: Partial<HostSettingsState["values"]> = {}): HostSettingsState {
  return {
    values: {
      lanEnabled: true,
      remoteControlEnabled: true,
      remoteHostname: "studio.example.com",
      keepAwake: true,
      notificationsEnabled: true,
      appearance: "system",
      ownerName: "",
      loginItem: false,
      defaultModel: "opus",
      defaultEffort: "high",
      metaAppId: "",
      linkedInClientId: "",
      ...overrides,
    },
    keys: [
      {
        name: "ELEVENLABS_API_KEY",
        label: "ElevenLabs API anahtarı",
        group: "worker",
        secret: true,
        saved: false,
        source: null,
      },
    ],
    info: {
      macName: "Test Mac",
      appVersion: "1.0.0",
      mode: "dev",
      hostEnabled: true,
      hostStatus: "Çalışıyor",
      hostError: false,
      apiPort: 8790,
      lanPort: 8791,
      lanUrls: ["http://192.168.50.2:8791"],
      tunnel: { state: "ok", detail: "Açık" },
      loginItemSupported: false,
      loginItemNote: "",
      keepAwakeActive: false,
      keepAwakeReason: null,
      keysSealed: true,
      updatesNote: "",
    },
  };
}

beforeEach(async () => {
  await env.DB.prepare("delete from host_settings_changes").run();
  await env.DB.prepare("delete from app_meta where key = 'host_settings_state'").run();
  await env.DB.prepare("delete from pairing_failures").run();
});

describe("host settings bridge", () => {
  it("shows nothing until the Mac syncs, then its state", async () => {
    const phone = { ...lan(), ...bearer(await pairPhone()) };
    const empty = await call<HostSettingsView>("GET", "/api/host/settings", phone);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ state: null, live: false, via: "lan", changes: [] });

    const sync = await call<HostSettingsSyncResult>("POST", "/api/host/settings/sync", LOCAL, {
      state: state(),
    });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect(sync.body.pending).toEqual([]);
    const seen = await call<HostSettingsView>("GET", "/api/host/settings", phone);
    expect(seen.body.live).toBe(true);
    expect(seen.body.state?.values.defaultModel).toBe("opus");
  });

  it("queues a change with a sealed key, hands it to the Mac once, and records the result", async () => {
    const phone = { ...lan(), ...bearer(await pairPhone()) };
    await call("POST", "/api/host/settings/sync", LOCAL, { state: state() });
    const queued = await call<HostSettingsChange>("POST", "/api/host/settings/changes", phone, {
      values: { keepAwake: false, defaultModel: "sonnet" },
      keys: [{ name: "ELEVENLABS_API_KEY", value: "sk_eleven_1234567890" }],
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    expect(queued.body.status).toBe("pending");
    expect(queued.body.keys).toEqual([{ name: "ELEVENLABS_API_KEY", action: "set" }]);
    expect(JSON.stringify(queued.body)).not.toContain("sk_eleven");

    // The stored row never holds the plaintext.
    const raw = await env.DB.prepare("select keys from host_settings_changes where id = ?")
      .bind(queued.body.id)
      .first<{ keys: string }>();
    expect(raw?.keys).not.toContain("sk_eleven");

    // The phone's view shows it pending, without the value.
    const pendingView = await call<HostSettingsView>("GET", "/api/host/settings", phone);
    expect(pendingView.body.changes[0]?.status).toBe("pending");
    expect(JSON.stringify(pendingView.body)).not.toContain("sk_eleven");

    // Only the Mac gets the value.
    const sync = await call<HostSettingsSyncResult>("POST", "/api/host/settings/sync", LOCAL, {
      state: state(),
    });
    expect(sync.body.pending).toHaveLength(1);
    expect(sync.body.pending[0]?.keys).toEqual([
      { name: "ELEVENLABS_API_KEY", value: "sk_eleven_1234567890" },
    ]);
    expect(sync.body.pending[0]?.values).toEqual({ keepAwake: false, defaultModel: "sonnet" });

    const done = await call<HostSettingsSyncResult>("POST", "/api/host/settings/sync", LOCAL, {
      state: state({ keepAwake: false, defaultModel: "sonnet" }),
      results: [{ id: queued.body.id, ok: true, message: "Uygulandı." }],
    });
    expect(done.body.pending).toEqual([]);
    const after = await call<HostSettingsView>("GET", "/api/host/settings", phone);
    expect(after.body.changes[0]).toMatchObject({ status: "applied", message: "Uygulandı." });
    expect(after.body.state?.values.keepAwake).toBe(false);
    const erased = await env.DB.prepare("select keys from host_settings_changes where id = ?")
      .bind(queued.body.id)
      .first<{ keys: string }>();
    expect(erased?.keys).not.toContain("ciphertext");
  });

  it("refuses changes that would cut the phone's own route", async () => {
    const token = await pairPhone();
    await call("POST", "/api/host/settings/sync", LOCAL, { state: state() });
    const viaTunnel = { ...tunnel(), ...bearer(token) };
    const viaLan = { ...lan(), ...bearer(token) };

    expect((await call<HostSettingsView>("GET", "/api/host/settings", viaTunnel)).body.via).toBe(
      "tunnel",
    );
    for (const body of [
      { values: { remoteControlEnabled: false } },
      { values: { remoteHostname: "other.example.com" } },
      { keys: [{ name: "CLOUDFLARE_TUNNEL_TOKEN", value: "x".repeat(40) }] },
    ]) {
      const res = await call<ApiErrorBody>("POST", "/api/host/settings/changes", viaTunnel, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error.message).toBe(HOST_LOCKOUT_MESSAGES.tunnel);
    }
    // Through the tunnel, local network access may go off; through the LAN it may not.
    expect(
      (
        await call("POST", "/api/host/settings/changes", viaTunnel, {
          values: { lanEnabled: false },
        })
      ).status,
    ).toBe(202);
    const lanOff = await call<ApiErrorBody>("POST", "/api/host/settings/changes", viaLan, {
      values: { lanEnabled: false },
    });
    expect(lanOff.status).toBe(409);
    expect(lanOff.body.error.message).toBe(HOST_LOCKOUT_MESSAGES.lan);
    // Through the LAN, remote access may go off.
    expect(
      (
        await call("POST", "/api/host/settings/changes", viaLan, {
          values: { remoteControlEnabled: false },
        })
      ).status,
    ).toBe(202);
    // The Mac itself is never refused.
    expect(
      (await call("POST", "/api/host/settings/changes", LOCAL, { values: { lanEnabled: false } }))
        .status,
    ).toBe(202);
  });

  it("is for the owner; the sync is for the Mac itself only", async () => {
    const phone = { ...lan(), ...bearer(await pairPhone()) };
    const worker = { ...lan(), ...bearer("test-worker-token") };
    expect((await call("GET", "/api/host/settings", worker)).status).toBe(403);
    expect(
      (await call("POST", "/api/host/settings/changes", worker, { values: { keepAwake: true } }))
        .status,
    ).toBe(403);
    expect((await call("GET", "/api/host/settings", lan())).status).toBe(401);
    expect((await call("POST", "/api/host/settings/sync", phone, { state: state() })).status).toBe(
      403,
    );
    const bad = await call("POST", "/api/host/settings/changes", phone, {});
    expect(bad.status).toBe(400);
  });

  it("lets the phone store an AI key but never see its hint", async () => {
    const phone = { ...lan(), ...bearer(await pairPhone()) };
    const keys = await call<{ items: { hint: string | null }[] }>("GET", "/api/ai/keys", phone);
    expect(keys.status).toBe(200);
    expect(keys.body.items.every((k) => k.hint === null)).toBe(true);
  });
});
