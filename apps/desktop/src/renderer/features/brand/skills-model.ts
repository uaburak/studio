// Marka Kiti → Skill'ler as plain values (tested without views): the editor form, its checks,
// labels and the starting template of a new skill.
import {
  type BrandSkill,
  type BrandSkillOrigin,
  MAX_BRAND_SKILLS,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  uniqueSkillName,
} from "@studio/contract";

export interface SkillForm {
  name: string;
  description: string;
  body: string;
  /** Kept with the new version ("" = none). */
  note: string;
}

export const ORIGIN_LABEL: Record<BrandSkillOrigin, string> = {
  manual: "Elle",
  ai_draft: "AI taslağı",
  restore: "Geri yüklendi",
};

export const NEW_SKILL_BODY = `# Başlık

## Ne zaman kullanılır
- 

## Ölçüler ve yerleşim
- Tuval 1080×1350, kenar boşluğu 72 px.
- 

## Tipografi ve renk
- 

## Ton ve metin
- 

## Yapılacaklar
- 

## Yapılmayacaklar
- 
`;

export function formOf(skill: BrandSkill | null): SkillForm {
  return {
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    body: skill?.body ?? NEW_SKILL_BODY,
    note: "",
  };
}

/** A new skill's form with a free name (`yeni-skill`, `yeni-skill-2` …). */
export function newSkillForm(existing: readonly Pick<BrandSkill, "name">[]): SkillForm {
  return {
    ...formOf(null),
    name: uniqueSkillName(
      "yeni-skill",
      existing.map((s) => s.name),
    ),
  };
}

/** True when saving would store a new version (or create the skill). */
export function formChanged(form: SkillForm, skill: BrandSkill | null): boolean {
  if (!skill) return true;
  return (
    form.name.trim() !== skill.name ||
    form.description.trim() !== skill.description ||
    form.body !== skill.body
  );
}

/** The first reason the form cannot be saved (Turkish), or null. */
export function skillFormProblem(
  form: SkillForm,
  others: readonly Pick<BrandSkill, "name">[],
): string | null {
  const name = form.name.trim();
  if (!name) return "Skill'e bir ad ver.";
  if (name.length > 48 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return "Ad küçük harf, rakam ve tire içermeli (ör. tek-gorsel-post).";
  }
  if (others.some((s) => s.name === name)) return `“${name}” adında bir skill zaten var.`;
  if (form.description.trim().length > MAX_SKILL_DESCRIPTION_CHARS) {
    return `Açıklama en fazla ${MAX_SKILL_DESCRIPTION_CHARS} karakter olabilir.`;
  }
  if (!form.body.trim()) return "Skill metni boş olamaz.";
  if (form.body.length > MAX_SKILL_BODY_CHARS) {
    return `Skill metni en fazla ${MAX_SKILL_BODY_CHARS.toLocaleString("tr-TR")} karakter olabilir.`;
  }
  return null;
}

/** Why "Yeni skill" cannot add one (limit), or null. */
export function addSkillBlocker(count: number): string | null {
  return count >= MAX_BRAND_SKILLS
    ? `Bir markada en fazla ${MAX_BRAND_SKILLS} skill olabilir.`
    : null;
}

/** Why "AI ile çıkar" cannot start, or null. */
export function skillDraftBlocker(input: {
  archived: boolean;
  workerOnline: boolean;
  count: number;
}): string | null {
  if (input.archived) return "Arşivlenmiş markada skill çıkarılamaz.";
  const limit = addSkillBlocker(input.count);
  if (limit) return limit;
  if (!input.workerOnline) return "Arka plan çalışmıyor; Studio hazır olunca skill çıkarılabilir.";
  return null;
}

/** "Ad · v3" line under a skill in the list. */
export function skillMeta(skill: BrandSkill): string {
  const parts = [`v${skill.version}`];
  if (skill.origin !== "manual") parts.push(ORIGIN_LABEL[skill.origin]);
  if (!skill.enabled) parts.push("kapalı");
  return parts.join(" · ");
}

/** Characters of a body, for the editor's counter. */
export function bodyLength(body: string): string {
  return `${body.length.toLocaleString("tr-TR")} / ${MAX_SKILL_BODY_CHARS.toLocaleString("tr-TR")}`;
}
