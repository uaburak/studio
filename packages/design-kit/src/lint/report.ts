import { z } from "zod";
import { CONTRACT_LIMITS } from "../contract/constants.ts";
import { CONTRACT_VERSION, KIT_VERSION, LINT_REPORT_SCHEMA } from "../version.ts";
import { isRuleId, LINT_RULES, type RuleId, type Severity } from "./rules.ts";

export const SeveritySchema = z.enum(["error", "warning", "info"]);

export const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Rect = z.infer<typeof RectSchema>;

export const LintIssueSchema = z.object({
  rule: z.string(),
  severity: SeveritySchema,
  layer: z.string().nullable(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type LintIssue = z.infer<typeof LintIssueSchema>;

export const ContrastSchema = z.object({
  median: z.number(),
  worst: z.number(),
  required: z.number(),
  background: z.string(),
});

export const TextMetricsSchema = z.object({
  lines: z.number().int(),
  fontSize: z.number(),
  minFontSize: z.number(),
  weight: z.string(),
  family: z.string(),
  color: z.string(),
  textRect: RectSchema,
  chars: z.number().int(),
  contrast: ContrastSchema.optional(),
});

export const LayerMetricsSchema = z.object({
  id: z.string(),
  type: z.string(),
  role: z.string().nullable(),
  parent: z.string().nullable(),
  /** Border box in artboard px (only with the layout stage). */
  rect: RectSchema.nullable(),
  visible: z.boolean(),
  /** Plain text of a text layer (first 200 characters). */
  content: z.string().optional(),
  text: TextMetricsSchema.optional(),
});
export type LayerMetrics = z.infer<typeof LayerMetricsSchema>;

/** Versioned JSON report. `schema` changes only on breaking changes. */
export const LintReportSchema = z.object({
  schema: z.literal(LINT_REPORT_SCHEMA),
  kit: z.string(),
  contract: z.string(),
  artboard: z.object({ width: z.number(), height: z.number() }),
  ok: z.boolean(),
  summary: z.object({
    errors: z.number().int(),
    warnings: z.number().int(),
    info: z.number().int(),
  }),
  stages: z.object({
    static: z.boolean(),
    layout: z.boolean(),
    pixel: z.boolean(),
    render: z.boolean(),
  }),
  issues: z.array(LintIssueSchema),
  layers: z.array(LayerMetricsSchema),
  fontsLoaded: z.array(z.string()).optional(),
  timing: z.record(z.string(), z.number()).optional(),
});
export type LintReport = z.infer<typeof LintReportSchema>;

export const CarouselLintReportSchema = z.object({
  schema: z.literal(LINT_REPORT_SCHEMA),
  kind: z.literal("carousel"),
  ok: z.boolean(),
  summary: z.object({
    errors: z.number().int(),
    warnings: z.number().int(),
    info: z.number().int(),
  }),
  /** Cross-slide issues; `layer` is prefixed with the slide index: `2:counter`. */
  issues: z.array(LintIssueSchema),
  slides: z.array(LintReportSchema),
});
export type CarouselLintReport = z.infer<typeof CarouselLintReportSchema>;

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface VoidOptions {
  /** Warn when the largest empty rectangle covers at least this share of the safe area. */
  minAreaRatio: number;
  /** ...and both its sides are at least this share of the safe area's sides. */
  minSideRatio: number;
  /** Grid cell size in px. */
  cell: number;
}

export interface LintConfig {
  /** Target artboard size (the platform preset). */
  width: number;
  height: number;
  safeArea?: number | SafeArea;
  minFontSize?: number;
  bodyFontSize?: number;
  legalMinFontSize?: number;
  maxLayers?: number;
  /** Brand font families; when omitted the font-family rule is skipped. */
  brandFonts?: readonly string[];
  /** facts.json `allowedNumbers`; when omitted numbers are not checked (`numbers-unchecked`). */
  allowedNumbers?: readonly string[];
  /** Brand language for `lang` (default `tr`). */
  lang?: string;
  /** Default logo clear space as a fraction of the logo's rendered height (default 0.5). */
  logoClearSpace?: number;
  /** Per-logo clear space by file path under /brand/ (from brand tokens). */
  logoClearSpaceByPath?: Readonly<Record<string, number>>;
  void?: Partial<VoidOptions>;
  /** Change a rule's severity or turn it off. */
  rules?: Partial<Record<RuleId, Severity | "off">>;
}

export const DEFAULT_VOID: VoidOptions = { minAreaRatio: 0.24, minSideRatio: 0.3, cell: 12 };

export function resolveSafeArea(s: LintConfig["safeArea"]): SafeArea {
  if (s === undefined) {
    const v = CONTRACT_LIMITS.safeArea;
    return { top: v, right: v, bottom: v, left: v };
  }
  return typeof s === "number" ? { top: s, right: s, bottom: s, left: s } : s;
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Apply severity overrides, drop duplicates, sort deterministically. */
export function finalizeIssues(
  issues: readonly LintIssue[],
  config: Pick<LintConfig, "rules">,
): LintIssue[] {
  const out: LintIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const override = isRuleId(issue.rule) ? config.rules?.[issue.rule] : undefined;
    if (override === "off") continue;
    const severity = override ?? issue.severity;
    const key = `${issue.rule}|${issue.layer ?? ""}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...issue, severity });
  }
  return out.sort(
    (a, b) =>
      ORDER[a.severity] - ORDER[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      (a.layer ?? "").localeCompare(b.layer ?? "") ||
      a.message.localeCompare(b.message),
  );
}

export function summarize(issues: readonly LintIssue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}

export function issue(
  rule: RuleId,
  layer: string | null,
  message: string,
  data?: Record<string, unknown>,
): LintIssue {
  return { rule, severity: LINT_RULES[rule].severity, layer, message, ...(data ? { data } : {}) };
}

export function buildReport(parts: {
  config: LintConfig;
  issues: LintIssue[];
  layers: LayerMetrics[];
  stages: LintReport["stages"];
  fontsLoaded?: string[];
  timing?: Record<string, number>;
}): LintReport {
  const issues = finalizeIssues(parts.issues, parts.config);
  const summary = summarize(issues);
  return {
    schema: LINT_REPORT_SCHEMA,
    kit: KIT_VERSION,
    contract: CONTRACT_VERSION,
    artboard: { width: parts.config.width, height: parts.config.height },
    ok: summary.errors === 0,
    summary,
    stages: parts.stages,
    issues,
    layers: parts.layers,
    ...(parts.fontsLoaded ? { fontsLoaded: parts.fontsLoaded } : {}),
    ...(parts.timing ? { timing: parts.timing } : {}),
  };
}

/** Compact form of a report for prompts (critique-and-revise, fix with a prompt). */
export function lintForPrompt(report: LintReport) {
  return {
    ok: report.ok,
    summary: report.summary,
    issues: report.issues.map(({ rule, severity, layer, message }) => ({
      rule,
      severity,
      layer,
      message,
    })),
    text: report.layers
      .filter((l) => l.text)
      .map((l) => {
        const t = l.text as NonNullable<LayerMetrics["text"]>;
        return {
          id: l.id,
          role: l.role,
          lines: t.lines,
          fontSize: t.fontSize,
          minFontSize: t.minFontSize,
          textRect: t.textRect,
          contrast: t.contrast
            ? `${t.contrast.median}:1 (min ${t.contrast.worst}:1, need ${t.contrast.required}:1)`
            : null,
        };
      }),
  };
}
