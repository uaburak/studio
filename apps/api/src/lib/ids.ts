let lastMs = 0;
let counter = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, then a 12-bit counter, then
 * random bits. Ids sort lexicographically in creation order, which keyset
 * pagination relies on (`ORDER BY id`). The counter keeps ids monotonic
 * within one isolate even when the Workers clock does not advance between
 * calls (it is frozen until the next I/O).
 */
export function newId(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    counter++;
    if (counter > 0xfff) {
      lastMs++;
      counter = 0;
    }
    ms = lastMs;
  } else {
    lastMs = ms;
    counter = 0;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 48-bit big-endian timestamp.
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
