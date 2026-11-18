import type { Device, MacRoutes, PairingCode } from "@studio/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeSecondsLeft,
  countdown,
  deviceStatus,
  formatPairingCode,
  freshlyPaired,
  lastSeenText,
  needsNewOffer,
  type PairingApi,
  PairingController,
  RENEW_BEFORE_MS,
} from "../../src/renderer/features/devices/pairing-controller.ts";
import {
  encodeQueryItem,
  inviteFromOffer,
  inviteUrl,
  isInviteExpired,
  isIPv4,
  makeInvite,
} from "../../src/renderer/features/devices/pairing-invite.ts";
import { encodeQr, qrPath, qrVersionFor } from "../../src/renderer/lib/qr.ts";

// The secret of StudioKit's QRPairingTests.
const secret = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c";
const expiry = 1_794_900_000_000;

/**
 * Expected links printed by StudioKit's `PairingInvite.url` (Foundation `URLComponents`) for the
 * same inputs — the invites of PairingInvite's tests plus extra characters. Generated on macOS
 * with a copy of PairingInvite.swift's URL code; the Mac's QR card and this one must agree.
 */
const SWIFT_VECTORS: { name: string; invite: Parameters<typeof makeInvite>[0]; url: string }[] = [
  {
    name: "full",
    invite: {
      macName: "Deniz’s MacBook Pro & Co + 2",
      secret,
      expiresAt: expiry,
      macId: "8f1c2a4e-0000-4000-8000-000000000001",
      lanAddresses: ["192.168.1.20", "10.0.0.5"],
      lanPort: 8791,
      bonjourName: "Deniz’s MacBook Pro (2)",
      tunnelUrl: "https://social.example.net",
    },
    url: "studio://pair?v=1&n=Deniz%E2%80%99s%20MacBook%20Pro%20%26%20Co%20%2B%202&s=Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c&e=1794900000&i=8f1c2a4e-0000-4000-8000-000000000001&a=192.168.1.20,10.0.0.5&p=8791&b=Deniz%E2%80%99s%20MacBook%20Pro%20(2)&t=https://social.example.net",
  },
  {
    name: "minimal",
    invite: { macName: "Mac", secret, expiresAt: expiry },
    url: "studio://pair?v=1&n=Mac&s=Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c&e=1794900000",
  },
  {
    name: "whole seconds",
    invite: { macName: "Mac", secret, expiresAt: expiry + 750 },
    url: "studio://pair?v=1&n=Mac&s=Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c&e=1794900000",
  },
  {
    name: "offer",
    invite: {
      macName: "Mac",
      secret,
      expiresAt: expiry,
      macId: "m1",
      lanAddresses: ["192.168.1.2"],
      lanPort: 8791,
      bonjourName: "Mac",
      tunnelUrl: null,
    },
    url: "studio://pair?v=1&n=Mac&s=Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c&e=1794900000&i=m1&a=192.168.1.2&p=8791",
  },
  {
    name: "junk addresses, query in the tunnel",
    invite: {
      macName: "Deniz's MacBook Pro",
      secret,
      expiresAt: expiry,
      macId: "mac-1",
      lanAddresses: ["1.2.3.4", "999.1.1.1", "fe80::1", "abc", "01.2.3.4", "192.0.2.1"],
      lanPort: 8791,
      tunnelUrl: "https://studio.ornek.com/path?x=1&y=2",
    },
    url: "studio://pair?v=1&n=Deniz's%20MacBook%20Pro&s=Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c&e=1794900000&i=mac-1&a=1.2.3.4,192.0.2.1&p=8791&t=https://studio.ornek.com/path?x%3D1%26y%3D2",
  },
  {
    name: "characters",
    invite: {
      macName: "Ağ İş Çay=Şık;#?/:@!$'()*,~-._ %",
      secret: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ-_0123456789",
      expiresAt: expiry,
      bonjourName: 'Ağ İş [x] {y} |z| ^\\ `q` "r" <s>',
    },
    url: "studio://pair?v=1&n=A%C4%9F%20%C4%B0%C5%9F%20%C3%87ay%3D%C5%9E%C4%B1k;%23?/:@!$'()*,~-._%20%25&s=abcdefghijklmnopqrstuvwxyzABCDEFGHIJ-_0123456789&e=1794900000&b=A%C4%9F%20%C4%B0%C5%9F%20%5Bx%5D%20%7By%7D%20%7Cz%7C%20%5E%5C%20%60q%60%20%22r%22%20%3Cs%3E",
  },
];

describe("pairing invite link (StudioKit PairingInvite)", () => {
  for (const vector of SWIFT_VECTORS) {
    it(`encodes “${vector.name}” exactly like the Mac`, () => {
      expect(inviteUrl(makeInvite(vector.invite))).toBe(vector.url);
    });
  }

  it("is compact enough for a comfortable QR code", () => {
    expect(inviteUrl(makeInvite(SWIFT_VECTORS[0]?.invite as never)).length).toBeLessThan(400);
  });

  it("encodes query values like URLComponents plus the %2B fix", () => {
    expect(encodeQueryItem("a b+c&d=e#f")).toBe("a%20b%2Bc%26d%3De%23f");
    expect(encodeQueryItem("-._~!$'()*,;:@/?")).toBe("-._~!$'()*,;:@/?");
    expect(encodeQueryItem("ç")).toBe("%C3%A7");
  });

  it("checks IPv4 like IPv4Text", () => {
    expect(isIPv4("192.168.1.20")).toBe(true);
    expect(isIPv4("0.0.0.0")).toBe(true);
    for (const bad of [
      "999.1.1.1",
      "01.2.3.4",
      "1.2.3",
      "fe80::1",
      "abc",
      "1.2.3.4.5",
      "1..2.3",
      " 1.2.3.4",
    ]) {
      expect(isIPv4(bad), bad).toBe(false);
    }
  });

  it("builds from a pairing offer and the Mac's routes; old servers have no QR secret", () => {
    const routes: MacRoutes = {
      macName: "Mac",
      macId: "m1",
      lanAddresses: ["192.168.1.2"],
      lanPort: 8791,
      bonjourName: null,
      tunnelUrl: null,
      updatedAt: "2026-11-17T10:00:00.000Z",
    };
    const offer: PairingCode = {
      code: "123456",
      expiresAt: "2026-11-17T10:02:00.000Z",
      secret,
      secretExpiresAt: new Date(expiry).toISOString(),
    };
    const invite = inviteFromOffer(offer, routes);
    expect(invite && inviteUrl(invite)).toBe(SWIFT_VECTORS[3]?.url);
    expect(inviteFromOffer({ code: "123456", expiresAt: offer.expiresAt }, routes)).toBeNull();
    if (!invite) throw new Error("no invite");
    expect(isInviteExpired(invite, expiry - 1_000)).toBe(false);
    expect(isInviteExpired(invite, expiry)).toBe(true);
  });
});

describe("QR code", () => {
  // CIQRCodeGenerator (correctionLevel "M") output for the same texts, quiet zone removed: the
  // Mac's QR card draws these exact modules.
  const COREIMAGE: { text: string; rows: string[] }[] = [
    {
      text: '!(/6=DKRY`gnu")07>EL',
      rows: [
        "1111111010000110001111111",
        "1000001011100100101000001",
        "1011101000111101001011101",
        "1011101010101011101011101",
        "1011101001011011001011101",
        "1000001000111110101000001",
        "1111111010101010101111111",
        "0000000010010000000000000",
        "1011011100110110001001011",
        "0010000010010100000100100",
        "0101111001110000110111110",
        "1010110001001100100110100",
        "1100011011100000011100100",
        "0011100010010111011111011",
        "0101001001001010110110000",
        "1000110000101100010001011",
        "0010101101110000111111110",
        "0000000010101100100011001",
        "1111111010111000101010001",
        "1000001010101000100011010",
        "1011101001111100111110110",
        "1011101010001110011100011",
        "1011101011011101011110010",
        "1000001001000001011011100",
        "1111111011101010000011011",
      ],
    },
    {
      text: "Ağ İş Çay — ünicode ✓",
      rows: [
        "11111110011101110011101111111",
        "10000010010011111110101000001",
        "10111010101111010000001011101",
        "10111010111100110101001011101",
        "10111010110000011111101011101",
        "10000010101110000100001000001",
        "11111110101010101010101111111",
        "00000000111110101001100000000",
        "10111110011000001101001111100",
        "11111001001001110011101110011",
        "11110111110001111000011110010",
        "01000100111011010010100011101",
        "10101111001000110101110000001",
        "00100100101110011011011111000",
        "00011111000010000001110100011",
        "00110000001000101001010110110",
        "11100110100010001110001011100",
        "10010100011111110010111000010",
        "10110011100011111011010100001",
        "10110001010011010110011011100",
        "10101011110100110100111110010",
        "00000000101010011010100011010",
        "11111110010010000111101011000",
        "10000010101000101110100010111",
        "10111010101110000010111111001",
        "10111010100101110100011011100",
        "10111010100110111001010101110",
        "10000010010110000111010010010",
        "11111110110011111010110010100",
      ],
    },
  ];

  for (const vector of COREIMAGE) {
    it(`matches CoreImage module for module (${vector.rows.length}×${vector.rows.length})`, () => {
      const matrix = encodeQr(vector.text);
      expect(matrix.modules.map((r) => r.map((c) => (c ? "1" : "0")).join(""))).toEqual(
        vector.rows,
      );
    });
  }

  it("picks CoreImage's version for the pairing link (byte mode, level M)", () => {
    const url = SWIFT_VECTORS[0]?.url ?? "";
    // 270 bytes → version 12 (65 modules); CoreImage's image is 67 with its 1-module margin.
    expect(encodeQr(url).version).toBe(12);
    expect(encodeQr(url).size).toBe(65);
    expect(qrVersionFor(1)).toBe(1);
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(2331)).toBe(40);
    expect(qrVersionFor(2332)).toBeNull();
  });

  it("draws finder patterns and a path of dark runs", () => {
    const m = encodeQr("studio://pair?v=1");
    const row0 = m.modules[0]
      ?.slice(0, 7)
      .map((c) => (c ? 1 : 0))
      .join("");
    expect(row0).toBe("1111111");
    expect(m.modules[m.size - 8]?.[8]).toBe(true); // the dark module
    expect(
      qrPath(
        {
          version: 1,
          size: 2,
          mask: 0,
          modules: [
            [true, true],
            [false, true],
          ],
        },
        1,
      ),
    ).toBe("M1 1h2v1h-2zM2 2h1v1h-1z");
  });
});

// --- refresh loop -------------------------------------------------------------------------------------

function device(id: string, createdAtMs: number, over: Partial<Device> = {}): Device {
  return {
    id,
    name: `iPhone ${id}`,
    platform: "ios",
    createdAt: new Date(createdAtMs).toISOString(),
    lastSeenAt: null,
    revokedAt: null,
    ...over,
  };
}

function fakeApi(clock: { now: number }) {
  let n = 0;
  const state = { devices: [] as Device[], failCreate: false, routesMissing: false };
  const api = {
    createCode: vi.fn(async (): Promise<PairingCode> => {
      if (state.failCreate) throw new Error("Studio sunucusuna ulaşılamadı.");
      n += 1;
      return {
        code: String(100000 + n),
        expiresAt: new Date(clock.now + 120_000).toISOString(),
        secret: `${secret.slice(0, -1)}${n}`,
        secretExpiresAt: new Date(clock.now + 600_000).toISOString(),
      };
    }),
    routes: vi.fn(async (): Promise<MacRoutes> => {
      if (state.routesMissing) throw new Error("routes not found");
      return {
        macName: "Deniz's MacBook Pro",
        macId: "mac-1",
        lanAddresses: ["192.168.1.20"],
        lanPort: 8791,
        bonjourName: null,
        tunnelUrl: null,
        updatedAt: new Date(clock.now).toISOString(),
      };
    }),
    devices: vi.fn(async () => state.devices),
    revoke: vi.fn(async (id: string) => {
      state.devices = state.devices.map((d) =>
        d.id === id ? { ...d, revokedAt: new Date(clock.now).toISOString() } : d,
      );
      return state.devices.find((d) => d.id === id) as Device;
    }),
  } satisfies PairingApi;
  return { api, state };
}

describe("pairing refresh", () => {
  afterEach(() => vi.useRealTimers());

  it("renews the QR offer 20 s before its secret runs out, not earlier", async () => {
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const { api } = fakeApi(clock);
    const c = new PairingController({ api: () => api, now: () => clock.now, autoRefresh: false });
    c.show();
    await c.step();
    expect(c.getSnapshot().phase).toEqual({ kind: "ready" });
    expect(api.createCode).toHaveBeenCalledTimes(1);
    const first = c.getSnapshot().url;
    expect(first).toMatch(/^studio:\/\/pair\?v=1&n=Deniz's%20MacBook%20Pro&s=/);
    expect(first).toContain(
      `&e=${Math.floor((clock.now + 600_000) / 1000)}&i=mac-1&a=192.168.1.20&p=8791`,
    );

    clock.now += 600_000 - RENEW_BEFORE_MS - 1_000; // 21 s left
    await c.step();
    expect(api.createCode).toHaveBeenCalledTimes(1);
    clock.now += 2_000; // 19 s left
    await c.step();
    expect(api.createCode).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().url).not.toBe(first);
  });

  it("counts the typed code down and keeps the QR after the code runs out", async () => {
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const { api } = fakeApi(clock);
    const c = new PairingController({ api: () => api, now: () => clock.now, autoRefresh: false });
    c.show();
    await c.step();
    const offer = c.getSnapshot().offer;
    expect(codeSecondsLeft(offer, clock.now)).toBe(120);
    expect(countdown(codeSecondsLeft(offer, clock.now + 15_500))).toBe("1:45");
    expect(codeSecondsLeft(offer, clock.now + 200_000)).toBe(0);
    expect(formatPairingCode("123456")).toBe("123 456");
    expect(needsNewOffer(null, clock.now)).toBe(true);
  });

  it("says “iPhone bağlandı” when a phone paired with the code on screen", async () => {
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const { api, state } = fakeApi(clock);
    state.devices = [device("old", clock.now - 86_400_000)];
    const c = new PairingController({ api: () => api, now: () => clock.now, autoRefresh: false });
    c.show();
    await c.step(); // tick 1: devices + offer
    clock.now += 5_000;
    state.devices = [device("new", clock.now), ...state.devices];
    await c.step(); // tick 2: no device read
    expect(c.getSnapshot().phase.kind).toBe("ready");
    await c.step(); // tick 3
    await c.step(); // tick 4: reads the devices
    expect(c.getSnapshot().phase).toEqual({ kind: "paired", name: "iPhone new" });
    expect(c.getSnapshot().url).toBeNull();
    await c.step();
    expect(api.createCode).toHaveBeenCalledTimes(1);
    // "Başka bir iPhone bağla".
    await c.renewOffer();
    expect(c.getSnapshot().phase.kind).toBe("ready");
    expect(api.createCode).toHaveBeenCalledTimes(2);
    // Reopening the card after a pairing offers a new code.
    const d = freshlyPaired([], [device("x", 0)], 10_000);
    expect(d).toBeNull();
  });

  it("retries a failed offer every ten rounds", async () => {
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const { api, state } = fakeApi(clock);
    state.failCreate = true;
    const c = new PairingController({ api: () => api, now: () => clock.now, autoRefresh: false });
    c.show();
    await c.step(); // tick 1
    expect(c.getSnapshot().phase).toEqual({
      kind: "failed",
      message: "Studio sunucusuna ulaşılamadı.",
    });
    state.failCreate = false;
    for (let i = 2; i <= 9; i++) await c.step();
    expect(api.createCode).toHaveBeenCalledTimes(1);
    await c.step(); // tick 10
    expect(api.createCode).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().phase.kind).toBe("ready");
  });

  it("is unavailable without the Mac's server and fails without routes", async () => {
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const offline = new PairingController({ api: () => null, autoRefresh: false });
    offline.show();
    await offline.step();
    expect(offline.getSnapshot().phase.kind).toBe("unavailable");
    const { api, state } = fakeApi(clock);
    state.routesMissing = true;
    const c = new PairingController({ api: () => api, now: () => clock.now, autoRefresh: false });
    c.show();
    await c.step();
    expect(c.getSnapshot().phase.kind).toBe("failed");
    expect(api.createCode).not.toHaveBeenCalled();
  });

  it("removes a device and says so", async () => {
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const { api, state } = fakeApi(clock);
    state.devices = [device("a", clock.now - 1_000_000)];
    const c = new PairingController({ api: () => api, now: () => clock.now, autoRefresh: false });
    c.show();
    await c.step();
    await c.remove(state.devices[0] as Device);
    expect(api.revoke).toHaveBeenCalledWith("a");
    expect(c.getSnapshot().message).toEqual({
      text: "iPhone a kaldırıldı. Yeniden bağlamak için QR kodu okutması yeter.",
      error: false,
    });
    expect(c.getSnapshot().devices[0]?.revokedAt).not.toBeNull();
  });

  it("runs every second only while a card is on screen", async () => {
    vi.useFakeTimers();
    const clock = { now: Date.parse("2026-11-17T10:00:00.000Z") };
    const { api } = fakeApi(clock);
    const c = new PairingController({ api: () => api, now: () => clock.now });
    c.show();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(api.createCode).toHaveBeenCalledTimes(1);
    expect(api.devices).toHaveBeenCalledTimes(2); // ticks 1 and 4
    c.hide();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.devices).toHaveBeenCalledTimes(2);
  });

  it("shows when each device was last seen", () => {
    const now = Date.parse("2026-11-17T12:00:00.000Z");
    expect(deviceStatus(device("a", 0), now)).toEqual({ text: "Henüz görülmedi", online: false });
    expect(
      deviceStatus(device("a", 0, { lastSeenAt: new Date(now - 60_000).toISOString() }), now),
    ).toEqual({
      text: "Bağlı",
      online: true,
    });
    expect(lastSeenText(new Date(now - 30 * 60_000).toISOString(), now)).toBe("30 dk önce");
    expect(lastSeenText(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2 gün önce");
    expect(lastSeenText(new Date(now - 86_400_000).toISOString(), now)).toBe("dün");
    expect(lastSeenText("2026-09-01T10:00:00.000Z", now)).toBe("1 Eyl");
  });
});
