/**
 * The signed-in person's name from Claude Code's local profile.
 *
 * Claude Code keeps the account profile of the signed-in user in `~/.claude.json`
 * (or `$CLAUDE_CONFIG_DIR/.claude.json`) under `oauthAccount`: `displayName`, `fullName`,
 * `emailAddress`, organisation fields... Tokens are not in that file. Studio only needs a
 * first name for the greeting, so this reads `displayName` (else the first word of
 * `fullName`) and nothing else. The value goes into presence `claude.displayName`, which
 * stays between this Mac's API and the owner's paired phones; it is never logged.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Claude Code keeps its profile for this environment. */
export function claudeProfilePath(env: Record<string, string | undefined> = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return join(configDir, ".claude.json");
  return join(env.HOME?.trim() || homedir(), ".claude.json");
}

const MAX_NAME_LENGTH = 40;

/** One word of letters (plus `'` / `-` inside), or null. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 120) return null;
  // An email address or handle is not a name.
  if (trimmed.includes("@")) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function firstWord(raw: unknown): string | null {
  const name = cleanName(raw);
  if (!name) return null;
  const word = name.split(" ")[0] ?? "";
  return /^\p{L}[\p{L}'’-]*$/u.test(word) ? word : null;
}

/**
 * The greeting name from the text of a `.claude.json`: `oauthAccount.displayName`, else the
 * first word of `oauthAccount.fullName`. Null when the file has no signed-in account or the
 * values do not look like a name.
 */
export function profileNameFromClaudeJson(text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const account = (data as Record<string, unknown>).oauthAccount;
  if (!account || typeof account !== "object") return null;
  const fields = account as Record<string, unknown>;
  return cleanName(fields.displayName) ?? firstWord(fields.fullName);
}

/** Read the greeting name from `path`; null when the file is missing or unreadable. */
export async function readClaudeProfileName(path = claudeProfilePath()): Promise<string | null> {
  try {
    // The file also holds project history; it is read whole but only the name leaves here.
    return profileNameFromClaudeJson(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
