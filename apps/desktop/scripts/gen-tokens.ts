// Generates src/renderer/styles/tokens.css from src/renderer/design/tokens.json (the Wecra
// "Studio › Claude Code" Foundations). Run: pnpm --filter @studio/desktop tokens
// The renderer test `tokens.test.ts` fails when the CSS is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTokensCss, type TokenDoc } from "../src/shared/tokens.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = JSON.parse(
  readFileSync(join(root, "src/renderer/design/tokens.json"), "utf8"),
) as TokenDoc;
writeFileSync(join(root, "src/renderer/styles/tokens.css"), renderTokensCss(doc));
console.log("tokens.css written");
