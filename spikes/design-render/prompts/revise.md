Critique and revise

Below is your first-pass design for this brief, its rendered output (attached image{{PLURAL}}: {{IMAGE_LIST}}),
and the automatic linter report. Review it as the brand's senior art director would, then fix it.

Brief (Turkish): {{BRIEF}}
Requirements:
{{REQUIREMENTS}}

1. Look at the render{{PLURAL}} first, not the code. Judge honestly and specifically:
   - hierarchy and focal point; is the one idea instantly readable on a phone?
   - spacing rhythm and alignment to the 72px margin / 6-column grid; optical balance; empty areas that feel accidental
   - typographic quality: sizes, weights, leading, tracking, line breaks, rag, widows, Turkish diacritics colliding
   - brand fidelity to DESIGN.md (does it feel like the Venta pack?) and voice/facts fidelity
   - anything that looks like generic AI output (template feel, decoration without purpose)
   {{CAROUSEL_NOTE}}
2. Fix every linter `error`. Fix `warning`s unless you have a design reason (say it in `changes`).
3. Improve the design based on your critique. Keep `data-layer` ids of layers that still exist.
   Do not start over unless the first pass is fundamentally wrong; say so if you do.

Return JSON with:
- `critique`: the problems you found, most severe first: `{ "issue", "severity": "high|medium|low", "fix" }`
- `slides`: the complete revised HTML for every slide (same ids)
- `caption`: revised caption
- `rationale`: 2–4 sentences
- `changes`: list of what you changed

<linter_report>
{{LINT}}
</linter_report>

<first_pass_html>
{{HTML}}
</first_pass_html>
