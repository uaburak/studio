/**
 * Numbers guard (contract §7): a design may only state numbers that appear in the brand's
 * high-confidence facts (`facts.json` → `allowedNumbers`). Catches the most dangerous
 * hallucinations (doses, percentages, years) mechanically. Also used for captions.
 *
 * Fixed against the spike: a unit is only taken when it is attached to the number
 * (`3b`, `150g`), so `10 bor` is reported as `10`, not `10 bo`; Turkish `%10` is a percentage.
 */

export interface NumberToken {
  /** As written, including an attached unit or percent sign (`%10`, `3b`, `150g`). */
  text: string;
  /** Digits with separators (`1.5`, `036`). */
  core: string;
  /** Letters attached directly after the digits (lowercased, at most 2). */
  suffix: string;
  percent: boolean;
  index: number;
}

const NUMBER = /(%\s?)?(\d+(?:[.,]\d+)*)(\p{L}{1,2}(?!\p{L}))?(\s?%)?/gu;

export function extractNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const core = m[2] as string;
    const suffix = (m[3] ?? "").toLocaleLowerCase("tr");
    out.push({
      text: m[0].trim(),
      core,
      suffix,
      percent: Boolean(m[1] || m[4]),
      index: m.index ?? 0,
    });
  }
  return out;
}

function variants(core: string): string[] {
  const stripped = core.replace(/^0+(?=\d)/, "");
  const swapped = core.includes(",") ? core.replace(/,/g, ".") : core.replace(/\./g, ",");
  return [...new Set([core, stripped, swapped, swapped.replace(/^0+(?=\d)/, "")])];
}

export function isAllowedNumber(token: NumberToken, allowed: readonly string[]): boolean {
  const set = new Set(allowed.map((a) => a.toLocaleLowerCase("tr").replace(/\s+/g, "")));
  for (const v of variants(token.core)) {
    if (set.has(v)) return true;
    if (token.suffix && set.has(v + token.suffix)) return true;
  }
  return false;
}

export function findUnverifiedNumbers(text: string, allowed: readonly string[]): NumberToken[] {
  return extractNumbers(text).filter((t) => !isAllowedNumber(t, allowed));
}

export function hasPercent(text: string): boolean {
  return /%/.test(text);
}
