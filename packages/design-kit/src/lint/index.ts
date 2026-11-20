// Linter: rule registry, static checks, orchestration and the in-page script (isomorphic).
export { type CarouselOptions, lintCarousel } from "./carousel.ts";
export {
  type ContrastResult,
  contrastRatio,
  measureContrast,
  parseComputedColor,
  type Raster,
  relativeLuminance,
} from "./contrast.ts";
export { clearSpaceIssues, type LogoBox, largestEmptyRect, voidIssues } from "./geometry.ts";
export {
  HIDE_TEXT_CSS,
  IN_PAGE_LINT_SCRIPT,
  type InPageBox,
  type InPageFinding,
  type InPageInput,
  type InPageRect,
  type InPageResult,
  type InPageText,
  inPageLintInvocation,
  studioInPageLint,
} from "./inpage.ts";
export {
  extractNumbers,
  findUnverifiedNumbers,
  isAllowedNumber,
  type NumberToken,
} from "./numbers.ts";
export {
  buildReport,
  type CarouselLintReport,
  CarouselLintReportSchema,
  DEFAULT_VOID,
  issue,
  type LayerMetrics,
  type LintConfig,
  type LintIssue,
  type LintReport,
  LintReportSchema,
  lintForPrompt,
  resolveSafeArea,
  type SafeArea,
  type VoidOptions,
} from "./report.ts";
export {
  isRuleId,
  LINT_RULES,
  type LintStage,
  RULE_IDS,
  type RuleId,
  type RuleMeta,
  type Severity,
} from "./rules.ts";
export {
  inPageInput,
  type LintOptions,
  type LintPage,
  lintSlide,
  lintSlideStatic,
  type NetworkLog,
} from "./run.ts";
export { staticLint } from "./static.ts";
