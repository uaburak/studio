// Copies contract/DESIGN_CONTRACT.v1.md into src/contract/text.ts so the contract text is
// importable everywhere (browser bundles included) without file system access.
// A test fails when the two drift apart. Usage: pnpm --filter @studio/design-kit sync:contract
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync(new URL("../contract/DESIGN_CONTRACT.v1.md", import.meta.url), "utf8");
const escaped = md.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
const ts = `// GENERATED from contract/DESIGN_CONTRACT.v1.md by scripts/sync-contract.mjs. Do not edit.
/** The design contract v1 as Markdown, for generation prompts. */
export const DESIGN_CONTRACT_MD = \`${escaped}\`;
`;
writeFileSync(new URL("../src/contract/text.ts", import.meta.url), ts);
console.log(`wrote src/contract/text.ts (${md.length} chars)`);
