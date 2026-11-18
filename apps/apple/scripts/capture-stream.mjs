// Captures the first frames of the job stream and a conversation stream
// (Node 24, global WebSocket). Used by capture-fixtures.sh.
//
//   node capture-stream.mjs <api-base-url> <conversation-id> <out-dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [api, conversationId, out] = process.argv.slice(2);
const ws = api.replace(/^http/, "ws");

function firstFrames(url, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // Node's WebSocket takes headers in its second argument; the API wants the owner secret.
    const socket = new WebSocket(url, {
      headers: { "X-Studio-Owner": process.env.STUDIO_OWNER_SECRET ?? "" },
    });
    const frames = [];
    const timer = setTimeout(() => {
      socket.close();
      frames.length ? resolve(frames) : reject(new Error(`no frames from ${url}`));
    }, timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "ping", ts: 1763290000000 })));
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(event.data));
      if (frames.length >= count) {
        clearTimeout(timer);
        socket.close();
        resolve(frames);
      }
    });
    socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)));
  });
}

const save = (name, value) => {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  ${name}.json`);
};

const jobFrames = await firstFrames(`${ws}/api/jobs/stream`, 2);
save("stream-jobs-snapshot", jobFrames.find((f) => f.type === "jobs.snapshot"));
const pong = jobFrames.find((f) => f.type === "pong");
if (pong) save("stream-pong", pong);

const convFrames = await firstFrames(`${ws}/api/conversations/${conversationId}/stream`, 1);
save("stream-conversation-snapshot", convFrames[0]);

// Resume from an earlier seq: the stored events after it, then conversation.resumed.
const seq = convFrames[0].seq;
const resumed = await firstFrames(`${ws}/api/conversations/${conversationId}/stream?after=${Math.max(0, seq - 6)}`, 7);
save("stream-conversation-resume", resumed);
