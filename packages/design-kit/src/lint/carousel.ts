/**
 * Cross-slide checks for a carousel: the slides must read as one system.
 */
import { LINT_REPORT_SCHEMA } from "../version.ts";
import {
  type CarouselLintReport,
  finalizeIssues,
  issue,
  type LayerMetrics,
  type LintConfig,
  type LintIssue,
  type LintReport,
  summarize,
} from "./report.ts";

export interface CarouselOptions {
  /** Max position difference (px) for anchors (logo, counter, sign-off, edge bands). Default 4. */
  tolerance?: number;
  rules?: LintConfig["rules"];
}

const ANCHOR_ROLES = new Set(["counter", "sign-off", "legal"]);

function isAnchor(l: LayerMetrics, height: number): boolean {
  if (l.type === "logo" || (l.role && ANCHOR_ROLES.has(l.role))) return true;
  const r = l.rect;
  if (!r || l.type === "text" || l.type === "group") return false;
  return r.y + r.h <= height * 0.15 || r.y >= height * 0.85;
}

/** Numbers in a counter: `02 / 05` -> [2, 5]. */
function counterNumbers(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

export function lintCarousel(
  slides: readonly LintReport[],
  options: CarouselOptions = {},
): CarouselLintReport {
  const tol = options.tolerance ?? 4;
  const issues: LintIssue[] = [];
  const first = slides[0];
  if (first) {
    // artboards
    for (const [i, s] of slides.entries())
      if (s.artboard.width !== first.artboard.width || s.artboard.height !== first.artboard.height)
        issues.push(
          issue(
            "carousel-artboard-mismatch",
            `${i + 1}:`,
            `Slide ${i + 1} is ${s.artboard.width}x${s.artboard.height}, slide 1 is ${first.artboard.width}x${first.artboard.height}.`,
          ),
        );

    // anchors: present on every slide, same place
    const maps = slides.map((s) => new Map(s.layers.map((l) => [l.id, l])));
    for (const l of first.layers) {
      if (!l.visible || !l.rect || !isAnchor(l, first.artboard.height)) continue;
      const all = maps.map((m) => m.get(l.id));
      if (all.some((x) => !x?.rect)) continue;
      for (let i = 1; i < slides.length; i++) {
        const o = all[i] as LayerMetrics;
        const a = l.rect;
        const b = o.rect as NonNullable<LayerMetrics["rect"]>;
        const d = Math.max(
          Math.abs(a.x - b.x),
          Math.abs(a.y - b.y),
          l.type === "logo" ? Math.abs(a.h - b.h) : 0,
        );
        if (d > tol)
          issues.push(
            issue(
              "carousel-anchor-drift",
              `${i + 1}:${l.id}`,
              `"${l.id}" is at (${b.x}, ${b.y}) on slide ${i + 1} but (${a.x}, ${a.y}) on slide 1; keep it in the same place on every slide.`,
              { slide: i + 1, delta: d },
            ),
          );
      }
    }

    // counters
    for (const [i, s] of slides.entries()) {
      for (const l of s.layers) {
        if (l.role !== "counter" || !l.content) continue;
        const nums = counterNumbers(l.content);
        if (!nums.length) continue;
        if (nums[0] !== i + 1 || (nums.length > 1 && nums[1] !== slides.length))
          issues.push(
            issue(
              "carousel-counter",
              `${i + 1}:${l.id}`,
              `Counter "${l.content}" on slide ${i + 1} of ${slides.length} should read ${i + 1} / ${slides.length}.`,
            ),
          );
      }
    }

    // font family per role
    const families = new Map<string, Set<string>>();
    for (const s of slides)
      for (const l of s.layers) {
        if (!l.role || !l.text?.family) continue;
        const set = families.get(l.role) ?? new Set<string>();
        set.add(l.text.family);
        families.set(l.role, set);
      }
    for (const [role, set] of families)
      if (set.size > 1)
        issues.push(
          issue(
            "carousel-font-drift",
            null,
            `Role "${role}" uses different font families across slides: ${[...set].join(" | ")}.`,
          ),
        );
  }
  const final = finalizeIssues(issues, { rules: options.rules });
  const summary = summarize(final);
  const slideErrors = slides.reduce((n, s) => n + s.summary.errors, 0);
  return {
    schema: LINT_REPORT_SCHEMA,
    kind: "carousel",
    ok: summary.errors === 0 && slideErrors === 0,
    summary,
    issues: final,
    slides: [...slides],
  };
}
