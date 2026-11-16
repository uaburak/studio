// Compile index.html into one self-contained document (runtime + variables + inlined assets)
// that <hyperframes-player> can load from any static host. The raw index.html is not enough:
// without the compiled runtime the variables (CSS custom properties, data-var-*) are never applied.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";

const html = await bundleToSingleHtml(".", { entryFile: "index.html" });
await rm("player-dist", { recursive: true, force: true });
await mkdir("player-dist", { recursive: true });
await writeFile("player-dist/index.html", html);
// Variable defaults such as data-var-src="assets/…" are resolved at runtime relative to the document,
// so the assets folder has to sit next to the bundle. (Keeping the bundle out of the project root
// also avoids lint's multiple_root_compositions error.)
await cp("assets", "player-dist/assets", { recursive: true });
console.log("player-dist/index.html", (html.length / 1024).toFixed(0), "KB");
