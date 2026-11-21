import { describe, expect, it } from "vitest";
import {
  HostSettingsChangeCreate,
  HostSettingsPatch,
  HostSettingsState,
  HostSettingsSync,
} from "../src/index.ts";

const state = {
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
    metaAppId: "123",
    linkedInClientId: "",
  },
  keys: [
    {
      name: "ELEVENLABS_API_KEY",
      label: "ElevenLabs",
      group: "worker",
      secret: true,
      saved: true,
      source: "settings",
    },
  ],
  info: {
    macName: "Mac",
    appVersion: "1.0.0",
    mode: "dev",
    hostEnabled: true,
    hostStatus: "Çalışıyor",
    hostError: false,
    apiPort: 8790,
    lanPort: 8791,
    lanUrls: ["http://192.168.1.2:8791"],
    tunnel: { state: "ok", detail: "Açık" },
    loginItemSupported: false,
    loginItemNote: "",
    keepAwakeActive: false,
    keepAwakeReason: null,
    keysSealed: true,
    updatesNote: "",
  },
};

describe("host settings bridge schemas", () => {
  it("accepts the Mac's state and a sync with results", () => {
    expect(HostSettingsState.parse(state).values.defaultModel).toBe("opus");
    const sync = HostSettingsSync.parse({ state, results: [{ id: "c1", ok: true }] });
    expect(sync.results[0]?.message).toBeNull();
  });

  it("normalizes the tunnel hostname and refuses junk", () => {
    expect(HostSettingsPatch.parse({ remoteHostname: " https://studio.example.com/ " })).toEqual({
      remoteHostname: "studio.example.com",
    });
    expect(HostSettingsPatch.safeParse({ remoteHostname: "not a host" }).success).toBe(false);
    expect(HostSettingsPatch.safeParse({ metaAppId: "12a" }).success).toBe(false);
    expect(HostSettingsPatch.safeParse({ defaultModel: "gpt-9" }).success).toBe(false);
  });

  it("needs something to change", () => {
    expect(HostSettingsChangeCreate.safeParse({}).success).toBe(false);
    expect(HostSettingsChangeCreate.safeParse({ values: { keepAwake: false } }).success).toBe(true);
    expect(
      HostSettingsChangeCreate.safeParse({ keys: [{ name: "ELEVENLABS_API_KEY", value: null }] })
        .success,
    ).toBe(true);
    expect(
      HostSettingsChangeCreate.safeParse({ keys: [{ name: "SOMETHING_ELSE", value: "x" }] })
        .success,
    ).toBe(false);
  });
});
