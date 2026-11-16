/** "1,4 MB" (binary units, Turkish decimal comma). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPercent(value: number): string {
  return `%${Math.round(value * 100)}`;
}

/** Pretty JSON for read-only panels. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Initials for brand avatars: "MTM Agro" -> "MA". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.charAt(0)}${words[1]?.charAt(0)}`
      : (words[0]?.slice(0, 2) ?? "");
  return letters.toLocaleUpperCase("tr-TR");
}

/** Stable hue per id so each brand gets its own swatch. */
export function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
