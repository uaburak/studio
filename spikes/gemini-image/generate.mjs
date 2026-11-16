// T5 doğrulama: Gemini API ile görsel üretimi (isteğe bağlı referans görselle).
//
// Çalıştırma:
//   node --env-file=.env spikes/gemini-image/generate.mjs \
//     --prompt "..." [--ref urun.jpg ...] [--aspect 4:5] [--size 1K] [--model gemini-nano-banana-2.1]
//
// Anahtar yalnızca istek başlığında kullanılır; hiçbir yere yazdırılmaz.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { refs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--ref") out.refs.push(value);
    else if (flag.startsWith("--")) out[flag.slice(2)] = value;
    else continue;
    i++;
  }
  return out;
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const args = parseArgs(process.argv.slice(2));
const model = args.model ?? "gemini-nano-banana-2.1";
const aspectRatio = args.aspect ?? "4:5";
const imageSize = args.size ?? "1K";
const prompt =
  args.prompt ?? (args["prompt-file"] ? await readFile(resolve(args["prompt-file"]), "utf8") : undefined);

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY boş: .env dosyasına anahtarı yapıştır.");
  process.exit(3);
}
if (!prompt) {
  console.error("--prompt gerekli.");
  process.exit(2);
}

const parts = [{ text: prompt }];
for (const ref of args.refs) {
  const mimeType = MIME[extname(ref).toLowerCase()];
  if (!mimeType) {
    console.error(`Desteklenmeyen referans biçimi: ${ref} (jpg, png, webp)`);
    process.exit(2);
  }
  const data = (await readFile(resolve(ref))).toString("base64");
  parts.push({ inlineData: { mimeType, data } });
}

const started = Date.now();
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio, imageSize },
      },
    }),
  },
);
const body = await res.json().catch(() => ({}));
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!res.ok) {
  const err = body.error ?? {};
  console.error(`HTTP ${res.status} ${err.status ?? ""}: ${String(err.message ?? "").slice(0, 600)}`);
  process.exit(1);
}

const candidate = body.candidates?.[0];
const outParts = candidate?.content?.parts ?? [];
const images = outParts.filter((p) => p.inlineData?.data);

if (images.length === 0) {
  console.error(
    `Görsel dönmedi. finishReason=${candidate?.finishReason ?? "yok"} ` +
      `blockReason=${body.promptFeedback?.blockReason ?? "yok"}`,
  );
  for (const p of outParts) if (p.text) console.error(`metin: ${p.text.slice(0, 300)}`);
  process.exit(1);
}

const outDir = args.out ? resolve(args.out) : join(here, "out");
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

for (const [i, part] of images.entries()) {
  const { mimeType, data } = part.inlineData;
  const file = join(outDir, `${stamp}-${i + 1}.${EXT[mimeType] ?? "bin"}`);
  const bytes = Buffer.from(data, "base64");
  await writeFile(file, bytes);
  console.log(`kaydedildi: ${file} (${mimeType}, ${(bytes.length / 1024).toFixed(0)} KB)`);
}

console.log(
  JSON.stringify({
    model,
    modelVersion: body.modelVersion,
    aspectRatio,
    imageSize,
    referenceImages: args.refs.length,
    seconds: Number(seconds),
    usage: body.usageMetadata,
  }),
);
