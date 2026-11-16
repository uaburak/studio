// Probe: can a property-panel editor change text, colour, a duration and the image
// of this LLM-authored composition through @hyperframes/sdk, headlessly?
// Writes the edited HTML to player-dist/sdk-edited.html (not to index.html).
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { openComposition } from "@hyperframes/sdk";

const comp = await openComposition(await readFile("index.html", "utf8"), { history: true });
const out = {};
const tryOp = (name, op) => {
  const c = comp.can(op);
  out[name] = c.ok ? "ok" : `refused: ${c.code}`;
  if (c.ok) comp.dispatch(op);
};
out.variables = comp.listVariables().map((v) => v.id);
tryOp("setVariableValue productName", { type: "setVariableValue", id: "productName", value: "VENTA TEST" });
tryOp("setVariableValue colorPrimary", { type: "setVariableValue", id: "colorPrimary", value: "#D0302F" });
tryOp("setVariableValue productImage", { type: "setVariableValue", id: "productImage", value: { url: "assets/venta-borinc.png", fit: "cover" } });
const s3 = comp.find({}).find((id) => comp.getElement(id)?.domId === "s3") ?? comp.getElements().find((e) => e.id === "s3" || e.attributes?.id === "s3")?.id;
out.s3HfId = s3 ?? null;
out.timings = comp.getElementTimings();
const anims = [...comp.getAllAnimationIds()];
out.animationIds = anims;
if (anims[0]) {
  try { comp.setGsapTween(anims[0], { duration: 1.0 }); out["setGsapTween first"] = "ok"; }
  catch (e) { out["setGsapTween first"] = "threw: " + e.message; }
}
out.canUndo = comp.canUndo();
await mkdir("player-dist", { recursive: true });
await writeFile("player-dist/sdk-edited.html", comp.serialize());
comp.dispose();
console.log(JSON.stringify(out, null, 2));
