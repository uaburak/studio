/**
 * Brand skills in prompts (Marka Kiti → Skill'ler): the brand's enabled Markdown instructions
 * go into chat turns and design generations within a size budget.
 *
 * - Skills are ranked by how well they fit the task text (named in it, then description words
 *   it shares), then by name; included in full while they fit, the next one clipped when a
 *   useful part still fits, the rest listed by name and description only.
 * - `brandSkillsUsed` gives the same selection as short labels (`mtm v3`, `partner v1
 *   (kısaltıldı)`) for job outputs and version notes.
 */
import type { BrandSkill } from "@studio/contract";
import type { StudioApi } from "../api.ts";

/** Characters of skill text a chat turn gets (all skills together). */
export const CHAT_SKILLS_BUDGET = 14_000;
/** Characters of skill text a design generation gets. */
export const DESIGN_SKILLS_BUDGET = 16_000;
/** No single skill takes more than this. */
export const MAX_SKILL_CHARS = 9_000;
/** A clipped skill must keep at least this much to be worth including. */
const MIN_CLIPPED_CHARS = 1_200;

export type SkillInclusion = "full" | "clipped" | "listed";

export interface SelectedSkill {
  skill: BrandSkill;
  inclusion: SkillInclusion;
  /** The body as it goes into the prompt ("" when only listed). */
  text: string;
}

const words = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase("tr-TR")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );

/** Higher = fits the task text better. */
export function skillScore(skill: Pick<BrandSkill, "name" | "description">, task: string): number {
  if (!task.trim()) return 0;
  const lower = task.toLocaleLowerCase("tr-TR");
  let score = 0;
  const name = skill.name.toLowerCase();
  if (new RegExp(`(^|[^a-z0-9-])/?${name.replace(/-/g, "\\-")}($|[^a-z0-9-])`).test(lower)) {
    score += 100;
  }
  const taskWords = words(task);
  for (const w of words(`${skill.name.replace(/-/g, " ")} ${skill.description}`)) {
    if (taskWords.has(w)) score += 3;
  }
  return score;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return `${lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut}\n[… kısaltıldı]`;
}

export function selectBrandSkills(
  skills: readonly BrandSkill[],
  options: { budget: number; task?: string; maxSkillChars?: number },
): SelectedSkill[] {
  const maxSkill = options.maxSkillChars ?? MAX_SKILL_CHARS;
  const task = options.task ?? "";
  const ranked = skills
    .filter((s) => s.enabled && s.body.trim())
    .map((skill, index) => ({ skill, index, score: skillScore(skill, task) }))
    .sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name) || a.index - b.index,
    );
  let left = options.budget;
  return ranked.map(({ skill }) => {
    const body = skill.body.trim();
    const room = Math.min(left, maxSkill);
    if (body.length <= room) {
      left -= body.length;
      return { skill, inclusion: "full", text: body };
    }
    if (room >= MIN_CLIPPED_CHARS) {
      const text = clip(body, room);
      left -= text.length;
      return { skill, inclusion: "clipped", text };
    }
    return { skill, inclusion: "listed", text: "" };
  });
}

const INCLUSION_NOTE: Record<SkillInclusion, string> = {
  full: "",
  clipped: " (kısaltıldı)",
  listed: " (yalnızca adı)",
};

/** `["mtm v3", "partner v1 (kısaltıldı)"]`. */
export function brandSkillsUsed(selected: readonly SelectedSkill[]): string[] {
  return selected.map((s) => `${s.skill.name} v${s.skill.version}${INCLUSION_NOTE[s.inclusion]}`);
}

const attr = (value: string) => value.replace(/["<>\n]/g, " ").trim();

/** Turkish block for chat turns (`<marka_skilleri>`); "" without skills. */
export function chatSkillsBlock(selected: readonly SelectedSkill[]): string {
  if (selected.length === 0) return "";
  const included = selected.filter((s) => s.inclusion !== "listed");
  const listed = selected.filter((s) => s.inclusion === "listed");
  const parts = [
    "<marka_skilleri>",
    "Stüdyo sahibinin bu marka için yazdığı talimatlar (formatlar, ölçüler, ton, yapılacaklar / yapılmayacaklar). İşe uyan skill'in kurallarına uy; marka profilinden daha özel olduğunda skill geçerlidir. Postları tasarım motoru üretir: generate_post / revise_post brief'lerinde ilgili skill'in kurallarını açıkça belirt.",
    ...included.map(
      (s) =>
        `<skill ad="${attr(s.skill.name)}" surum="${s.skill.version}"${s.skill.description ? ` aciklama="${attr(s.skill.description)}"` : ""}>\n${s.text}\n</skill>`,
    ),
    listed.length > 0
      ? `Bağlama sığmayan skill'ler (yalnızca ad ve açıklama):\n${listed.map((s) => `- ${s.skill.name}: ${s.skill.description || "(açıklama yok)"}`).join("\n")}`
      : "",
    "</marka_skilleri>",
  ];
  return parts.filter(Boolean).join("\n");
}

/** English block for the design engine (`<brand_skills>`); "" without skills. */
export function designSkillsBlock(selected: readonly SelectedSkill[]): string {
  if (selected.length === 0) return "";
  const included = selected.filter((s) => s.inclusion !== "listed");
  const listed = selected.filter((s) => s.inclusion === "listed");
  const parts = [
    "<brand_skills>",
    "Brand-specific instructions the studio owner wrote for this brand (formats with pixel layouts, tone, do / don't). Follow the skill that fits this brief; where a skill is more specific than DESIGN.md, the skill wins. A skill never overrides the DESIGN CONTRACT, the brand tokens or FACTS.",
    ...included.map(
      (s) =>
        `<skill name="${attr(s.skill.name)}" version="${s.skill.version}"${s.skill.description ? ` description="${attr(s.skill.description)}"` : ""}>\n${s.text}\n</skill>`,
    ),
    listed.length > 0
      ? `Skills left out for size (name and description only):\n${listed.map((s) => `- ${s.skill.name}: ${s.skill.description || "(no description)"}`).join("\n")}`
      : "",
    "</brand_skills>",
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * The brand's enabled skills through the API (oldest first, filtered); none when the API has
 * no skills yet (older server, migration pending) or the call fails for another reason than
 * an abort: skills improve a generation but never block it.
 */
export async function loadEnabledBrandSkills(
  api: StudioApi,
  brandId: string,
  signal?: AbortSignal,
): Promise<BrandSkill[]> {
  try {
    const page = await api.client.brandSkills.list(
      brandId,
      { limit: 100 },
      signal ? { signal } : undefined,
    );
    return page.items.filter((s) => s.enabled);
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}
