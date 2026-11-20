// Safety rules of the MCP server.
//
// 1. Reads (GET) are free; ordinary writes are allowed.
// 2. Dangerous operations need an explicit `confirm: true` argument: anything that deletes,
//    disconnects accounts, publishes (now or on a schedule) or replies publicly, changes the
//    owner's devices / pairing / keys / secrets / sign-ins, spends money above the everyday level
//    (image generation, bulk generation, "go on with Gemini") or changes the AI budget.
// 3. Secrets in responses (tokens, keys, passwords …) are redacted before anything is returned.

export interface DangerRule {
  method: string;
  /** Matched against the OpenAPI path template, e.g. `/api/brands/{id}`. */
  path: RegExp;
  reason: string;
  /** Only dangerous for these arguments (default: always). */
  when?: (args: Record<string, unknown>) => boolean;
}

/** Job types that cost money or publish (POST /api/jobs). */
export const DANGEROUS_JOB_TYPES = new Set([
  "image.generate",
  "content.generate",
  "schedule.publish",
  "brand.analyze",
  "brand.skill_draft",
]);

function body(args: Record<string, unknown>): Record<string, unknown> {
  const value = args.body;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export const DANGER_RULES: readonly DangerRule[] = [
  { method: "DELETE", path: /.*/, reason: "siler (deletes)" },
  {
    method: "POST",
    path: /^\/api\/social-accounts\/\{id\}\/disconnect$/,
    reason: "hesabın bağlantısını keser ve token'ını siler (disconnects the account)",
  },
  {
    method: "PUT",
    path: /^\/api\/social-accounts\/\{id\}\/token$/,
    reason: "hesap token'ını değiştirir (replaces an account token)",
  },
  {
    method: "POST",
    path: /^\/api\/social-accounts\/(meta\/exchange|meta\/discover|linkedin\/oauth|linkedin\/connect)$/,
    reason: "hesap bağlar ve token saklar (connects an account, stores tokens)",
  },
  {
    method: "POST",
    path: /^\/api\/schedules\/publish-now$/,
    reason: "hemen yayınlar (publishes now, publicly)",
  },
  {
    method: "POST",
    path: /^\/api\/schedules$/,
    reason: "postu zamanlar; zamanı gelince kendiliğinden yayınlanır (schedules a public post)",
  },
  {
    method: "PATCH",
    path: /^\/api\/schedules\/\{id\}$/,
    reason: "zamanlanmış yayının saatini değiştirir (moves a scheduled publish)",
  },
  {
    method: "POST",
    path: /^\/api\/comments\/\{id\}\/(reply|moderate)$/,
    reason:
      "yorumlara herkese açık yanıt verir ya da yorum gizler / siler (public reply or moderation)",
  },
  {
    method: "POST",
    path: /^\/api\/comments\/\{id\}\/retry$/,
    reason: "başarısız yanıtı / moderasyonu yeniden gönderir (sends publicly)",
  },
  {
    method: "POST",
    path: /^\/api\/(pairing\/codes|devices\/\{id\}\/revoke)$/,
    reason: "cihaz eşleştirmesini değiştirir (changes device pairing)",
  },
  {
    method: "PUT",
    path: /^\/api\/pairing\/routes$/,
    reason: "telefonların Mac'e ulaşma adreslerini değiştirir (changes pairing routes)",
  },
  {
    method: "PUT",
    path: /^\/api\/ai\/keys\/\{provider\}$/,
    reason: "yapay zekâ API anahtarını değiştirir (changes an API key)",
  },
  {
    method: "PUT",
    path: /^\/api\/publishing\/cloud$/,
    reason: "bulut yayıncı adresini ve anahtarını değiştirir (changes publisher secrets)",
  },
  {
    method: "PUT",
    path: /^\/api\/ai\/(budget|preferences)$/,
    reason: "yapay zekâ bütçesini / harcama davranışını değiştirir (changes the AI budget)",
  },
  {
    method: "POST",
    path: /^\/api\/ai\/claude-limit\/decision$/,
    reason: "Claude sınırında ücretli Gemini'ye geçmeye karar verebilir (may spend money)",
  },
  {
    method: "POST",
    path: /^\/api\/workers\/(claude|codex|antigravity)\/login$/,
    reason: "Mac'te hesap oturumu açmayı başlatır (starts a sign-in)",
  },
  {
    method: "POST",
    path: /^\/api\/approvals\/\{id\}\/regenerate$/,
    reason: "görseli yeniden üretir (ücretli; paid generation)",
  },
  {
    method: "POST",
    path: /^\/api\/plans\/\{id\}\/generate$/,
    reason: "plan öğelerini toplu üretir (bulk generation, spends quota/money)",
  },
  {
    method: "POST",
    path: /^\/api\/contents\/(revise|repurpose)$/,
    reason: "birçok postu birden değiştirir / üretir (bulk generation)",
  },
  {
    method: "POST",
    path: /^\/api\/maintenance\/purge$/,
    reason: "çöp kutusundakileri kalıcı olarak siler (deletes for good)",
  },
  {
    method: "POST",
    path: /^\/api\/jobs$/,
    reason: "ücretli üretim ya da yayın işi başlatır (paid generation or publishing job)",
    when: (args) => DANGEROUS_JOB_TYPES.has(String(body(args).type ?? "")),
  },
  {
    method: "POST",
    path: /^\/api\/conversations\/\{id\}\/messages\/\{messageId\}\/consent$/,
    reason: "ajanın istediği işleme sahibin adına izin verir (allows an agent action as the owner)",
    when: (args) => body(args).allow === true,
  },
];

/** The rule that makes this call dangerous, if any. */
export function dangerFor(
  method: string,
  pathTemplate: string,
  args: Record<string, unknown> = {},
): DangerRule | null {
  for (const rule of DANGER_RULES) {
    if (rule.method !== method.toUpperCase() || !rule.path.test(pathTemplate)) continue;
    if (rule.when && !rule.when(args)) continue;
    return rule;
  }
  return null;
}

/** The rule that can make this operation dangerous (ignoring `when`), for descriptions. */
export function possibleDanger(method: string, pathTemplate: string): DangerRule | null {
  return (
    DANGER_RULES.find((r) => r.method === method.toUpperCase() && r.path.test(pathTemplate)) ?? null
  );
}

export function confirmRefusal(toolName: string, reason: string): string {
  return (
    `Onay gerekli: ${toolName} tehlikeli bir işlem (${reason}). Sahip istediyse aynı çağrıyı ` +
    "`confirm: true` ile yineleyin. (Confirmation required: repeat the call with confirm: true " +
    "only if the owner asked for this.)"
  );
}

// --- redaction -----------------------------------------------------------------------------

export const REDACTED = "[gizli]";

const SECRET_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "devicetoken",
  "publishertoken",
  "workertoken",
  "pagetoken",
  "usertoken",
  "idtoken",
  "apikey",
  "secret",
  "clientsecret",
  "appsecret",
  "ownersecret",
  "qrsecret",
  "password",
  "passphrase",
  "privatekey",
  "vaultkey",
  "encryptionkey",
  "tokenencryptionkey",
  "authorization",
  "cookie",
  "credentials",
  "plaintext",
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True for object keys whose values are secrets. */
export function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  if (SECRET_KEYS.has(k)) return true;
  return (
    k.endsWith("token") ||
    k.endsWith("secret") ||
    k.endsWith("password") ||
    k.endsWith("apikey") ||
    k.endsWith("privatekey")
  );
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bEAA[A-Za-z0-9]{40,}/g,
];

/** Removes recognisable secrets from free text. */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Deep copy with secret fields replaced. Booleans, numbers and null stay (`hasToken: true` is
 * useful and harmless); strings and nested values under a secret key are replaced.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        isSecretKey(key) &&
        item !== null &&
        typeof item !== "boolean" &&
        typeof item !== "number"
      ) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}
