---
name: aylik-plan
description: Bir marka için bir aylık sosyal medya içerik planı hazırlar (8-12 post, sütun dengesi, görsel yuvaları).
---

# Aylık plan

1. Önce `get_brand_profile` ile ses tonunu, tasarım kurallarını ve gerçekleri (facts) oku. Profil yoksa ya da geçiciyse bunu yanıtta söyle.
2. Konuşmadaki görselleri `list_aliases` ile gör; kullanıcı belirli bir görseli bir post için istediyse o kalemde kullan.
3. Ay belirtilmediyse önümüzdeki ayı planla. İçinde bulunulan ay isteniyorsa yarından itibaren dağıt.
4. 8-12 post öner; haftada 2-3 post, hafta içine yayılmış. Türleri karıştır: çoğunlukla tek görsel, 2-3 carousel, istenirse story.
5. Sütunları dengele: ürün tanıtımı, uygulama ipuçları, marka hikâyesi, mevsimsel. Aynı sütunu art arda koyma.
6. Her kalemde 2-4 cümlelik brief, sütun, görsel yuvası (`user_upload`, `ai_generate` ya da `none`) ve görsel tarifi olsun. Rakam ve iddia yalnızca profildeki gerçeklerden.
7. Planı `propose_plan` ile öner. Yanıtta kalemleri tek tek sayma: stratejiyi, kaç post olduğunu, hangi görsellerin yüklenmesi gerektiğini ve sonraki adımı ("Planı onaylarsan postları üretirim") yaz.
