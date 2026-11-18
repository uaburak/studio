---
name: aylik-plan
description: Bir marka için bir aylık sosyal medya içerik planı hazırlar (8-12 post, sütun dengesi, Türkiye özel günleri, geçmişle tekrar denetimi, görsel yuvaları).
---

# Aylık plan

1. Önce `get_brand_profile` ile ses tonunu, tasarım kurallarını ve gerçekleri (facts) oku. Profil yoksa ya da geçiciyse bunu yanıtta söyle.
2. Konuşmadaki görselleri `list_aliases` ile gör; kullanıcı belirli bir görseli bir post için istediyse o kalemde kullan.
3. Ay belirtilmediyse önümüzdeki ayı planla. İçinde bulunulan ay isteniyorsa yarından itibaren dağıt.
4. Dönemin özel günlerini ve markanın son üç ayını oku: bağlamda o dönem için `<ozel_gunler>` ve `<gecmis_ozeti>` yoksa `get_planning_context` çağır.
   - Markaya uyan "önemli" günlere post koy ve tarihini o güne (ya da yazan hazırlık süresine) denk getir; her güne post zorunlu değil.
   - Dinî günlerde saygılı, sade tebrik; anma günlerinde (10 Kasım, 18 Mart, 6 Şubat) ciddi ve sade ton; bu günlerde satış ve kampanya yok. "±1 gün" yazan dinî günün tarihini kesin gibi sunma.
   - Geçmişteki kancaları ve konuları tekrarlama; reddedilen, plandan çıkarılan ve silinen konuları kullanıcı istemedikçe yeniden önerme.
5. 8-12 post öner; haftada 2-3 post, hafta içine yayılmış. Türleri karıştır: çoğunlukla tek görsel, 2-3 carousel, istenirse story.
6. Sütunları dengele: ürün tanıtımı, uygulama ipuçları, marka hikâyesi, mevsimsel / özel gün. Geçmişte az kullanılan sütunlara ağırlık ver; aynı sütunu art arda koyma.
7. Her kalemde 2-4 cümlelik brief, sütun, açılış cümlesi (`hook`, tek satır, geçmiştekilerden farklı), görsel yuvası (`user_upload`, `ai_generate` ya da `none`) ve görsel tarifi olsun. Rakam ve iddia yalnızca profildeki gerçeklerden.
8. Planı `propose_plan` ile öner. Araç benzer kalem bulursa planı göstermeden döner (`saved: false`): o kalemleri yeni bir konu ya da kancayla değiştirip yeniden çağır. Benzerliği bilerek koruyorsan aynı kalemlerle yeniden çağır; kalem kartta "Benzer" diye işaretlenir.
9. Yanıtta kalemleri tek tek sayma: stratejiyi, hangi özel günleri kullandığını, kaç post olduğunu, hangi görsellerin yüklenmesi gerektiğini ve sonraki adımı ("Planı onaylarsan postları üretirim") yaz.
