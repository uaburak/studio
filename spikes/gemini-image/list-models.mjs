// T5 doğrulama: anahtar çalışıyor mu, hangi görsel modelleri erişilebilir?
// Çalıştırma: node --env-file=.env spikes/gemini-image/list-models.mjs
// Anahtar yalnızca istek başlığında kullanılır; hiçbir yere yazdırılmaz.

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY boş: .env dosyasına anahtarı yapıştır.");
  process.exit(3);
}

const res = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  { headers: { "x-goog-api-key": key } },
);
const body = await res.json().catch(() => ({}));

if (!res.ok) {
  const err = body.error ?? {};
  console.error(`HTTP ${res.status} ${err.status ?? ""}: ${String(err.message ?? "").slice(0, 400)}`);
  process.exit(1);
}

const all = body.models ?? [];
const image = all.filter((m) => /image|banana/i.test(m.name));
console.log(`Anahtar geçerli. Toplam model: ${all.length}, görsel modeli: ${image.length}`);
for (const m of image) {
  console.log(`${m.name} | ${(m.supportedGenerationMethods ?? []).join(",")}`);
}
