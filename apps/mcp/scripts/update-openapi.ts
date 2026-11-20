// Regenerates apps/mcp/openapi.json, the copy the MCP server falls back to when Studio's API is
// not running yet.
//
//   pnpm -C apps/mcp openapi:update          from the API's source (no running app needed)
//   pnpm -C apps/mcp openapi:update --live   from the running app (GET /api/openapi.json)
//
// Run it after changing API routes and commit the result.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StudioClient } from "../src/client.ts";
import { CACHED_SPEC_PATH } from "../src/spec.ts";

async function fromSource(): Promise<unknown> {
  // A variable keeps apps/api out of this package's typecheck (it needs workerd types).
  const entry = fileURLToPath(new URL("../../api/src/app.ts", import.meta.url));
  const mod = (await import(entry)) as {
    app: { getOpenAPI31Document(config: Record<string, unknown>): unknown };
  };
  const version = (
    await import(fileURLToPath(new URL("../../api/src/version.ts", import.meta.url)))
  ).API_VERSION as string;
  return mod.app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Studio API", version },
  });
}

async function fromLive(): Promise<unknown> {
  const client = new StudioClient();
  const res = await client.request({ method: "GET", path: "/api/openapi.json" });
  if (res.status !== 200 || res.json === undefined) {
    throw new Error(`GET /api/openapi.json answered ${res.status}`);
  }
  return res.json;
}

const live = process.argv.includes("--live");
const doc = live ? await fromLive() : await fromSource();
writeFileSync(CACHED_SPEC_PATH, `${JSON.stringify(doc, null, 2)}\n`);
const paths = Object.keys((doc as { paths?: Record<string, unknown> }).paths ?? {}).length;
process.stdout.write(`openapi.json: ${paths} paths (${live ? "live" : "source"})\n`);
