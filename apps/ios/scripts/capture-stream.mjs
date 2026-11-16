// Records real frames from GET /api/jobs/stream (Node 22+ global WebSocket).
// Usage: node capture-stream.mjs <api> <brandId> <contentId> <outDir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [api, brandId, contentId, outDir] = process.argv.slice(2);
const wsUrl = `${api.replace(/^http/, "ws")}/api/jobs/stream?brandId=${encodeURIComponent(brandId)}`;
const frames = {};
let finished = false;
const save = (name, text) => {
  writeFileSync(join(outDir, name), `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  console.log(`  ${name}`);
};

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => {
  console.error("stream capture timed out", Object.keys(frames));
  process.exit(1);
}, 15_000);

ws.addEventListener("message", async (event) => {
  const text = String(event.data);
  const type = JSON.parse(text).type;
  if (frames[type]) return;
  frames[type] = text;
  if (type === "jobs.snapshot") {
    save("stream-snapshot.json", text);
    ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    const res = await fetch(`${api}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "content.generate", contentId, payload: { brief: "akış testi" } }),
    });
    const job = await res.json();
    await fetch(`${api}/api/jobs/${job.id}/cancel`, { method: "POST" });
  } else if (type === "job.updated") {
    save("stream-job-updated.json", text);
  } else if (type === "pong") {
    save("stream-pong.json", text);
  } else if (type === "presence") {
    save("stream-presence.json", text);
  }
  if (frames["jobs.snapshot"] && frames["job.updated"] && frames.pong) {
    finished = true;
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});
ws.addEventListener("error", (e) => {
  if (finished) return;
  console.error("stream error", e.message ?? e);
  process.exit(1);
});
