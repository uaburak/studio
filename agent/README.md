# agent/

Sohbet ajanının çalışma anı **skill**'leri. Kod içermez; pnpm çalışma alanına dahil değildir.

```
agent/skills/<ad>/SKILL.md     ön bilgi: name + description, ardından Türkçe talimat
```

Bugün üç skill var: `aylik-plan` (aylık içerik planı), `carousel` (carousel kurgusu), `urun-postu`
(ürün postu).

Nasıl kullanılır (`apps/worker/src/chat/skills.ts`):

- Her sohbet turunun isteminde skill'ler yalnızca ad ve açıklamayla listelenir; ajan uygun olanın
  metnini `get_skill` aracıyla alır (`list_skills` listeyi yeniden verir).
- `/ad` ile başlayan kullanıcı mesajı o skill'i çalıştırır: metni o turun istemine eklenir.
- Klasör: `STUDIO_SKILLS_DIR`, yoksa worker'dan yukarı doğru bulunan ilk `agent/skills`. Paketlenmiş
  Studio.app bu klasörün kopyasını `Resources/host/agent/skills` olarak taşır.

Markaya özel skill'ler burada değil, API'de markayla birlikte saklanır (Marka → Skill'ler; iş türü
`brand.skill_draft` geçmiş postlardan taslak çıkarır).

Yeni skill: ad küçük harf, rakam ve tire (`^[a-z0-9][a-z0-9-]{0,63}$`); `name` yoksa klasör adı
kullanılır, `description` yoksa metnin ilk satırı.
