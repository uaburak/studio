---
name: carousel
description: Kaydırmalı (carousel) post kurgular: kapak, 3-5 içerik slaydı ve kapanış; ardından üretimi başlatır.
---

# Carousel

1. Konu net değilse `ask_user` ile tek bir soru sor (konu ya da hedef). Makul bir varsayım yapabiliyorsan sorma.
2. Slayt akışını kur: 1 kapak (merak uyandıran kısa başlık), 3-5 içerik slaydı (her biri tek fikir, en fazla 25 kelime), 1 kapanış (çağrı ya da özet).
3. Metinler marka ses tonunda olsun; rakam ve iddia yalnızca marka profilindeki gerçeklerden (`get_brand_profile`).
4. Tasarım motoru ikon ya da illüstrasyon çizmez; görsel gerekiyorsa fotoğraf yuvası (`user_upload`) ya da yapay zekâ görseli (`ai_generate`) iste.
5. Brief'i slayt slayt yazıp `generate_post` ile `type: "carousel"` olarak üretimi başlat; sonra `wait_jobs` ile bekle ve `view_post` ile sonucu kontrol et.
6. Yanıtta slayt akışını kısaca özetle ve düzeltme isteyip istemediğini sor.
