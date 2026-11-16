/**
 * Runtime skills of the chat agent (A5): short Turkish playbooks in the repo's
 * `agent/skills/<name>/SKILL.md` (front matter `name` + `description`, then the text).
 *
 * - The turn prompt lists every skill by name and description only; the agent fetches
 *   one's text with the `get_skill` tool when it fits (`list_skills` lists them again).
 * - A user message that starts with `/name` runs that skill: its full text is put into
 *   that turn's prompt (as in Wecra, DesignerV2 providers/turns.ts `skillsNote`).
 *
 * The folder is `STUDIO_SKILLS_DIR`, else the first `agent/skills` found walking up from
 * this file (works for `tsx` sources and the bundled `dist/main.js`).
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Skill {
  name: string;
  description: string;
  /** The instructions (front matter removed). */
  text: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `agent/skills` above `from` (at most 8 levels), or null. */
export function findSkillsDir(
  from = path.dirname(fileURLToPath(import.meta.url)),
  configured?: string,
): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "agent", "skills");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Front matter (`---` … `---`) + body. Returns null without a valid name. */
export function parseSkill(source: string, fallbackName: string): Skill | null {
  let body = source.replace(/^﻿/, "");
  const meta: Record<string, string> = {};
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(body);
  if (fm?.[1]) {
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (m?.[1] && m[2] !== undefined)
        meta[m[1].toLowerCase()] = m[2].trim().replace(/^"|"$/g, "");
    }
    body = body.slice(fm[0].length);
  }
  const name = (meta.name || fallbackName).trim().toLowerCase();
  if (!NAME.test(name)) return null;
  const text = body.trim();
  const description = (meta.description || text.split("\n").find((l) => l.trim()) || name)
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return { name, description, text };
}

/** Every skill in `dir` (sorted by name); a missing folder is no skills. */
export async function loadSkills(dir: string | null): Promise<Skill[]> {
  if (!dir) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries.sort()) {
    const file = path.join(dir, entry, "SKILL.md");
    try {
      const skill = parseSkill(await readFile(file, "utf8"), entry);
      if (skill && !out.some((s) => s.name === skill.name)) out.push(skill);
    } catch {
      // not a skill folder
    }
  }
  return out;
}

/** `/name rest…` at the start of a user message: the skill and the rest of the text. */
export function invokedSkill(
  text: string,
  skills: readonly Skill[],
): { skill: Skill; rest: string } | null {
  const m = /^\s*\/([a-z0-9][a-z0-9-]*)(?:\s+|$)([\s\S]*)$/i.exec(text);
  if (!m?.[1]) return null;
  const skill = skills.find((s) => s.name === m[1]?.toLowerCase());
  return skill ? { skill, rest: (m[2] ?? "").trim() } : null;
}

/**
 * The turn's skills block: the others by name and description (fetch with `get_skill`),
 * and the invoked one in full.
 */
export function skillsNote(skills: readonly Skill[], invoked?: Skill | null): string {
  const parts: string[] = [];
  const others = skills.filter((s) => s.name !== invoked?.name).slice(0, 50);
  if (others.length > 0) {
    parts.push(
      `<beceriler>\nİşe uyduğunda talimatlarını get_skill {name} ile alıp uygula:\n${others
        .map((s) => `- ${s.name}: ${s.description}`)
        .join("\n")}\n</beceriler>`,
    );
  }
  if (invoked) {
    parts.push(
      `<calistirilan_beceri ad="${invoked.name}">\nKullanıcı bu mesajda /${invoked.name} becerisini çalıştırdı. Bu mesaj için talimatlarına uy:\n${invoked.text}\n</calistirilan_beceri>`,
    );
  }
  return parts.join("\n\n");
}
