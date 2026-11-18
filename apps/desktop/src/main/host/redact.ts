// Masks secrets in text that leaves the main process or lands in a log: the command-line header
// of every child log, log tails and status messages shown in Ayarlar → Gelişmiş (G2).
//
// Two layers: the exact values this app knows (worker token, vault key, owner secret, tunnel
// token), and patterns for secret-looking things it does not know (a `--token` argument,
// `…TOKEN=` / `…SECRET=` assignments, bearer tokens, Cloudflare tunnel tokens / JWTs, device
// tokens). Short values (< 8 characters) are never treated as secrets: masking them would only
// garble ordinary text.

export const MASK = "***";

const PATTERNS: [RegExp, string][] = [
  // `--token <value>`, `--token=<value>` (cloudflared and friends).
  [
    /(--(?:token|password|secret|api-key|access-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
    `$1${MASK}`,
  ],
  // NAME=value with a secret-looking name.
  [
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ENCRYPTION_KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g,
    `$1=${MASK}`,
  ],
  // Authorization: Bearer <value>
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  // The desktop app's owner header.
  [/\b(X-Studio-Owner\s*[:=]\s*)\S+/gi, `$1${MASK}`],
  // Cloudflare tunnel tokens are base64 JSON (`{"a":…`), JWTs too: both start with "eyJ".
  [/\beyJ[A-Za-z0-9_+/-]{16,}(?:\.[A-Za-z0-9_+/-]*){0,2}=*/g, MASK],
  // Studio device tokens.
  [/\bsdt_[A-Za-z0-9_-]{8,}/g, `sdt_${MASK}`],
];

/** `text` with every known value and every secret-looking pattern masked. */
export function redactSecrets(text: string, known: Iterable<string> = []): string {
  let out = text;
  const values = [...new Set([...known].map((v) => v.trim()).filter((v) => v.length >= 8))];
  // Longest first, so a value that contains another one is masked whole.
  values.sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(MASK);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** The secrets one host knows, applied to everything it shows or logs. */
export class Redactor {
  private readonly values = new Set<string>();

  add(...secrets: (string | null | undefined)[]): void {
    for (const secret of secrets) {
      const value = secret?.trim();
      if (value && value.length >= 8) this.values.add(value);
    }
  }

  redact(text: string): string {
    return text ? redactSecrets(text, this.values) : text;
  }
}
