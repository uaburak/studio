// "iPhone'u bağla" (port of StudioMac's PhonePairingModel): one pairing offer (QR code + 6-digit
// code), the paired devices and "Kaldır". While a QR card is on screen (`show()` … `hide()`) the
// offer is kept fresh: a new one replaces it 20 s before its QR secret runs out, and the device
// list is read every 3 s so the card can say "iPhone bağlandı" as soon as a phone paired.
import type { Device, MacRoutes, PairingCode } from "@studio/contract";
import { describeError } from "../../lib/api.ts";
import { inviteFromOffer, inviteUrl, type PairingInvite } from "./pairing-invite.ts";

export type PairingPhase =
  /** The Mac's own server is not running: nothing to pair with. */
  | { kind: "unavailable"; message: string }
  /** Making a new offer. */
  | { kind: "preparing" }
  /** Showing the QR code and the code. */
  | { kind: "ready" }
  /** A phone just paired with the offer on screen. */
  | { kind: "paired"; name: string }
  | { kind: "failed"; message: string };

export interface PairingApi {
  createCode(): Promise<PairingCode>;
  routes(): Promise<MacRoutes>;
  devices(): Promise<Device[]>;
  revoke(id: string): Promise<Device>;
}

export interface PairingSnapshot {
  phase: PairingPhase;
  offer: PairingCode | null;
  invite: PairingInvite | null;
  /** The QR code's text (`studio://pair?...`). */
  url: string | null;
  devices: Device[];
  hasLoadedDevices: boolean;
  /** Result of the last remove, or an error, for one line under the list. */
  message: { text: string; error: boolean } | null;
  /** Bumped every round (countdowns re-render). */
  tick: number;
}

/** Renew the offer this long before its QR secret expires (a phone never reads a dead code). */
export const RENEW_BEFORE_MS = 20_000;
/** Rounds between device list reads while the card shows (1 s rounds). */
export const DEVICE_POLL_ROUNDS = 3;
/** After a failure, rounds before the next attempt. */
export const RETRY_ROUNDS = 10;

export const PAIRING_STEPS =
  "iPhone'da Studio'yu aç, “iPhone'u bağla”ya dokun ve bu kodu okut. iPhone'un Kamera uygulamasıyla da okutabilirsin.";

export function needsNewOffer(invite: PairingInvite | null, nowMs: number): boolean {
  if (!invite) return true;
  return invite.expiresAt * 1000 - nowMs < RENEW_BEFORE_MS;
}

/** Seconds left for the typed code (0 when it ran out). */
export function codeSecondsLeft(offer: PairingCode | null, nowMs: number): number {
  if (!offer) return 0;
  return Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - nowMs) / 1000));
}

/** "123 456". */
export function formatPairingCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** "1:45". */
export function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The device a phone just paired with the offer on screen (made after the offer, new to the list). */
export function freshlyPaired(
  previous: readonly Device[],
  loaded: readonly Device[],
  offerMadeAtMs: number,
): Device | null {
  const known = new Set(previous.map((d) => d.id));
  return (
    loaded.find(
      (d) =>
        d.revokedAt === null &&
        !known.has(d.id) &&
        Date.parse(d.createdAt) >= offerMadeAtMs - 2_000,
    ) ?? null
  );
}

/** Paired devices that were not removed. */
export function activeDevices(devices: readonly Device[]): Device[] {
  return devices.filter((d) => d.revokedAt === null);
}

/** "5 dk önce", "3 sa önce", "dün", "2 gün önce", "12 Kas". */
export function lastSeenText(iso: string, nowMs: number): string {
  const then = new Date(iso);
  const diff = Math.max(0, nowMs - then.getTime());
  if (diff < 60_000) return "şimdi";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} dk önce`;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date(nowMs)) - startOf(then)) / 86_400_000);
  if (days === 0) return `${Math.floor(diff / 3_600_000)} sa önce`;
  if (days === 1) return "dün";
  if (days < 30) return `${days} gün önce`;
  const months = [
    "Oca",
    "Şub",
    "Mar",
    "Nis",
    "May",
    "Haz",
    "Tem",
    "Ağu",
    "Eyl",
    "Eki",
    "Kas",
    "Ara",
  ];
  return `${then.getDate()} ${months[then.getMonth()]}`;
}

/** "Bağlı" for a phone seen in the last ten minutes, else when it was last seen. */
export function deviceStatus(device: Device, nowMs: number): { text: string; online: boolean } {
  if (!device.lastSeenAt) return { text: "Henüz görülmedi", online: false };
  if (nowMs - Date.parse(device.lastSeenAt) < 10 * 60_000) return { text: "Bağlı", online: true };
  return { text: lastSeenText(device.lastSeenAt, nowMs), online: false };
}

export interface PairingControllerOptions {
  /** null: the API is not up (shows `unavailable`). */
  api: () => PairingApi | null;
  now?: () => number;
  /** Off in tests: nothing runs by itself, `step()` is called by hand. */
  autoRefresh?: boolean;
  unavailableMessage?: string;
}

export class PairingController {
  private snapshot: PairingSnapshot = {
    phase: { kind: "unavailable", message: "" },
    offer: null,
    invite: null,
    url: null,
    devices: [],
    hasLoadedDevices: false,
    message: null,
    tick: 0,
  };
  private readonly listeners = new Set<() => void>();
  private viewers = 0;
  private offerMadeAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly options: PairingControllerOptions;

  constructor(options: PairingControllerOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PairingSnapshot => this.snapshot;

  private update(patch: Partial<PairingSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  // --- lifecycle --------------------------------------------------------------------------------

  /** A QR card appeared: make an offer if needed and watch for the phone. */
  show() {
    // A card that opens again after a pairing offers a new code ("bağlandı" was for the last one).
    if (this.viewers === 0 && this.snapshot.phase.kind === "paired") {
      this.update({ phase: { kind: "ready" } });
    }
    this.viewers += 1;
    this.schedule(0);
  }

  hide() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) this.stop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    if (this.options.autoRefresh === false || this.viewers === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step().finally(() => this.schedule(1_000));
    }, delay);
  }

  // --- rounds -----------------------------------------------------------------------------------

  /** One round: refresh the list (every 3 s while showing), renew the offer when needed. */
  async step(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.round();
    } finally {
      this.running = false;
    }
  }

  private async round() {
    const api = this.options.api();
    if (!api) {
      const message =
        this.options.unavailableMessage ??
        "Studio hazırlanıyor; birazdan iPhone'u bağlayabilirsin.";
      this.update({
        phase: { kind: "unavailable", message },
        offer: null,
        invite: null,
        url: null,
      });
      return;
    }
    const tick = this.snapshot.tick + 1;
    this.update({ tick });
    const showing = this.viewers > 0;
    if (!showing || tick % DEVICE_POLL_ROUNDS === 1 || !this.snapshot.hasLoadedDevices) {
      await this.loadDevices(api);
    }
    const phase = this.snapshot.phase;
    if (phase.kind === "paired") return;
    if (phase.kind === "failed" && tick % RETRY_ROUNDS !== 0) return;
    if (needsNewOffer(this.snapshot.invite, this.now())) await this.makeOffer(api);
  }

  /** "Yeni kod", "Tekrar dene", "Başka bir iPhone bağla". */
  async renewOffer(): Promise<void> {
    const api = this.options.api();
    if (!api) return;
    if (this.snapshot.phase.kind === "paired") this.update({ phase: { kind: "ready" } });
    await this.makeOffer(api);
  }

  private async makeOffer(api: PairingApi) {
    if (!this.snapshot.offer) this.update({ phase: { kind: "preparing" } });
    try {
      const routes = await api.routes();
      const offer = await api.createCode();
      const invite = inviteFromOffer(offer, routes);
      if (!invite) {
        this.update({
          phase: {
            kind: "failed",
            message: "Bağlantı kodu hazırlanamadı. Studio'yu yeniden başlatıp tekrar dene.",
          },
        });
        return;
      }
      this.offerMadeAt = this.now();
      this.update({ offer, invite, url: inviteUrl(invite), phase: { kind: "ready" } });
    } catch (error) {
      this.update({
        phase: { kind: "failed", message: describeError(error) || "Bağlantı kodu hazırlanamadı." },
        offer: null,
        invite: null,
        url: null,
      });
    }
  }

  async loadDevices(api: PairingApi | null = this.options.api()): Promise<void> {
    if (!api) return;
    try {
      const loaded = await api.devices();
      const { devices, hasLoadedDevices } = this.snapshot;
      const showing = this.viewers > 0;
      const fresh =
        this.offerMadeAt !== null && showing && hasLoadedDevices
          ? freshlyPaired(devices, loaded, this.offerMadeAt)
          : null;
      if (fresh) {
        // The phone used the code on screen: say so, and do not show a used code.
        this.offerMadeAt = null;
        this.update({
          phase: { kind: "paired", name: fresh.name },
          offer: null,
          invite: null,
          url: null,
        });
      }
      this.update({
        devices: loaded,
        hasLoadedDevices: true,
        message: this.snapshot.message?.error ? null : this.snapshot.message,
      });
    } catch (error) {
      this.update({ message: { text: describeError(error), error: true } });
    }
  }

  async remove(device: Device): Promise<void> {
    const api = this.options.api();
    if (!api) return;
    try {
      await api.revoke(device.id);
      this.update({
        message: {
          text: `${device.name} kaldırıldı. Yeniden bağlamak için QR kodu okutması yeter.`,
          error: false,
        },
      });
      // "bağlandı" no longer holds: show a code again.
      if (this.snapshot.phase.kind === "paired") this.update({ phase: { kind: "ready" } });
      await this.loadDevices(api);
    } catch (error) {
      this.update({ message: { text: describeError(error), error: true } });
    }
  }
}
