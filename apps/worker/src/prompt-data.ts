/**
 * Untrusted text in prompts (brand profile, brand skills, brand and file names, plan text,
 * transcripts, design HTML, check reports) is data, never instructions. It goes inside a named
 * block whose meaning the prompt states, and any tag in it that could close that block or open
 * another one of the prompt's blocks is neutralised (`<` → `&lt;`), so the text stays inside.
 * Other markup (HTML / CSS examples in DESIGN.md, the design's own HTML) is left as it is.
 */

/** Block names used by Studio's prompts (chat: Turkish, design engine: English). */
export const PROMPT_BLOCK_TAGS = [
  // chat
  "bugun",
  "marka",
  "marka_profili",
  "marka_skilleri",
  "skill",
  "takma_adlar",
  "acik_plan",
  "konusma",
  "cevap",
  "yeni_mesaj",
  "beceriler",
  "veri",
  "ozel_gunler",
  "gecmis_ozeti",
  "performans_ozeti",
  "yayin_performansi",
  // comment replies (N16)
  "marka_sesi",
  "post_aciklamasi",
  "yorum",
  "yorum_dizisi",
  "onceki_yanitlar",
  // design engine
  "design_contract",
  "brand_css",
  "brand_tokens",
  "design_md",
  "voice_md",
  "facts_json",
  "brand_skills",
  "linter_report",
  "other_checks",
  "first_pass_html",
  "instruction",
  "current_caption",
  "current_html",
  "brief",
  "data",
  // generic role markers
  "system",
  "user",
  "assistant",
] as const;

const BLOCK_TAG = new RegExp(
  `<(?=\\s*/?\\s*(?:${PROMPT_BLOCK_TAGS.join("|")})(?:[\\s/>]|$))`,
  "gi",
);

/** `text` with every prompt block tag neutralised (`</marka_profili>` → `&lt;/marka_profili>`). */
export function asData(text: string): string {
  return text.replace(BLOCK_TAG, "&lt;");
}
