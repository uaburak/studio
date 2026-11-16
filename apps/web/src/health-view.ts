import type { HealthResponse } from "@studio/contract";

export type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; data: HealthResponse }
  | { kind: "error"; message: string };

export interface HealthView {
  title: string;
  detail: string;
  tone: "neutral" | "good" | "warn" | "bad";
}

/** Pure mapping from fetch state to Turkish UI text (kept separate for tests). */
export function describeHealth(state: HealthState): HealthView {
  switch (state.kind) {
    case "loading":
      return { title: "Kontrol ediliyor…", detail: "API'ye bağlanılıyor.", tone: "neutral" };
    case "error":
      return { title: "API'ye ulaşılamıyor", detail: state.message, tone: "bad" };
    case "ok": {
      const { data } = state;
      const db = data.checks.db === "ok" ? "veritabanı hazır" : "veritabanı hatası";
      const time = new Date(data.time).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
      return data.status === "ok"
        ? {
            title: "API çalışıyor",
            detail: `Sürüm ${data.version} · ${db} · ${time}`,
            tone: "good",
          }
        : { title: "API kısmen çalışıyor", detail: `${db} · ${time}`, tone: "warn" };
    }
  }
}
