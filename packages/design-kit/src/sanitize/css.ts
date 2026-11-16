import {
  type CssDeclaration,
  type CssRule,
  functionNames,
  parseDeclarationBlock,
  parseStylesheet,
  urlReferences,
} from "../html/css.ts";
import type { Splice } from "../html/dom.ts";
import { applySplices } from "../html/dom.ts";
import { isFragmentUrl, isVirtualAssetUrl } from "./url.ts";

export interface CssFinding {
  kind: "css-at-rule" | "css-url" | "css-property" | "css-expression";
  detail: string;
}

/** At-rules a design stylesheet may contain (anything else is removed). */
const ALLOWED_AT_RULES = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "scope",
  "starting-style",
  "keyframes",
  "-webkit-keyframes",
  "font-face",
  "counter-style",
  "property",
  "font-feature-values",
  "font-palette-values",
]);

/** Properties that once ran code or bound behaviour in some engine. Never allowed. */
const DANGEROUS_PROPERTIES = new Set(["behavior", "-ms-behavior", "-moz-binding", "binding"]);
const DANGEROUS_FUNCTIONS = new Set(["expression", "-moz-binding", "javascript"]);

export interface CssUrlPolicy {
  /** Allowed root-relative prefixes (default `/brand/`, `/media/`). */
  prefixes?: readonly string[];
}

/** Why a declaration must go, or `null` when it is safe. */
/** Remove a declaration together with the whitespace after it. */
function removeDeclaration(css: string, decl: CssDeclaration): Splice {
  let end = decl.end;
  while (end < css.length && /\s/.test(css[end] as string)) end++;
  return { start: decl.start, end, text: "" };
}

/** A string or ident that looks like a URL with a scheme or a protocol-relative URL. */
const URLISH = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function unsafeDeclarationReason(
  decl: CssDeclaration,
  policy: CssUrlPolicy = {},
): CssFinding | null {
  if (DANGEROUS_PROPERTIES.has(decl.name))
    return { kind: "css-property", detail: `property "${decl.name}" is not allowed` };
  // Custom properties have no meaning of their own; one holding a URL only exists to be
  // smuggled into a URL function somewhere else.
  if (
    decl.name.startsWith("--") &&
    decl.tokens.some((t) => t.type === "string" && URLISH.test(t.value.trim()))
  )
    return { kind: "css-url", detail: `custom property "${decl.name}" holds a URL` };
  const fns = functionNames(decl.tokens);
  const bad = fns.find((f) => DANGEROUS_FUNCTIONS.has(f));
  if (bad) return { kind: "css-expression", detail: `${bad}() in "${decl.name}"` };
  if (
    fns.includes("attr") &&
    decl.tokens.some(
      (t) =>
        (t.type === "ident" && t.value.toLowerCase() === "url") ||
        (t.type === "function" && t.value.toLowerCase() === "type"),
    )
  )
    return { kind: "css-url", detail: `typed attr() in "${decl.name}"` };
  const refs = urlReferences(decl.tokens);
  if (refs.bad) return { kind: "css-url", detail: `malformed url() in "${decl.name}"` };
  if (refs.dynamic)
    return {
      kind: "css-url",
      detail: `var()/env()/attr() inside a URL function in "${decl.name}"`,
    };
  for (const url of refs.urls) {
    const u = url.trim();
    if (!isFragmentUrl(u) && !isVirtualAssetUrl(u, policy.prefixes))
      return {
        kind: "css-url",
        detail: `url "${u.slice(0, 120)}" in "${decl.name}" is not an allowed asset URL`,
      };
  }
  return null;
}

function collectRuleSplices(
  css: string,
  rules: CssRule[],
  policy: CssUrlPolicy,
  splices: Splice[],
  findings: CssFinding[],
) {
  for (const rule of rules) {
    if (rule.kind === "at" && rule.name !== null && !ALLOWED_AT_RULES.has(rule.name)) {
      findings.push({ kind: "css-at-rule", detail: `@${rule.name} removed` });
      splices.push({ start: rule.start, end: rule.end, text: "" });
      continue;
    }
    // Strings in at-rule preludes are never URLs for the allowed at-rules, but url() could be.
    if (rule.kind === "at") {
      const refs = urlReferences(rule.preludeTokens);
      if (refs.urls.length > 0 || refs.bad) {
        findings.push({ kind: "css-url", detail: `url() in @${rule.name} prelude` });
        splices.push({ start: rule.start, end: rule.end, text: "" });
        continue;
      }
    } else if (urlReferences(rule.preludeTokens).urls.length > 0) {
      findings.push({ kind: "css-url", detail: "url() in a selector" });
      splices.push({ start: rule.start, end: rule.end, text: "" });
      continue;
    }
    for (const decl of rule.declarations) {
      const reason = unsafeDeclarationReason(decl, policy);
      if (reason) {
        findings.push(reason);
        splices.push(removeDeclaration(css, decl));
      }
    }
    collectRuleSplices(css, rule.rules, policy, splices, findings);
  }
}

/** Remove unsafe at-rules and declarations from a stylesheet. Unchanged input is returned as is. */
export function sanitizeStylesheet(
  css: string,
  policy: CssUrlPolicy = {},
): { css: string; findings: CssFinding[] } {
  const sheet = parseStylesheet(css);
  const splices: Splice[] = [];
  const findings: CssFinding[] = [];
  collectRuleSplices(css, sheet.rules, policy, splices, findings);
  return { css: splices.length ? applySplices(css, splices) : css, findings };
}

/** Remove unsafe declarations from a declaration list (a `style` attribute value). */
export function sanitizeDeclarationList(
  css: string,
  policy: CssUrlPolicy = {},
): { css: string; findings: CssFinding[] } {
  const { declarations, rules } = parseDeclarationBlock(css);
  const splices: Splice[] = [];
  const findings: CssFinding[] = [];
  for (const rule of rules) {
    findings.push({ kind: "css-at-rule", detail: "rule block inside a style attribute removed" });
    splices.push({ start: rule.start, end: rule.end, text: "" });
  }
  for (const decl of declarations) {
    const reason = unsafeDeclarationReason(decl, policy);
    if (reason) {
      findings.push(reason);
      splices.push(removeDeclaration(css, decl));
    }
  }
  return { css: splices.length ? applySplices(css, splices) : css, findings };
}
