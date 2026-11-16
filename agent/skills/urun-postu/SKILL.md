---
name: urun-postu
description: Kullanıcının yüklediği ürün fotoğrafıyla tek görselli ürün tanıtım postu hazırlar.
---

# Ürün postu

1. Ürün fotoğrafını bul: son mesajdaki ek ya da @takma ad. Emin değilsen `list_aliases`, sonra `view_alias` ile fotoğrafa bak.
2. Fotoğraf yoksa kullanıcıdan yüklemesini iste ve dur; görsel uydurma.
3. `get_brand_profile` ile ürün adını ve izinli gerçekleri oku. Etiketteki ürün adını ve yazıları değiştirme; profilde olmayan rakam, doz ya da iddia yazma.
4. Kısa bir başlık (en fazla 6 kelime), bir yan cümle ve bir çağrı belirle.
5. `generate_post` ile `type: "post"`, `imageSlot: "user_upload"` ve görsel tarifinin başında `@takma-ad` olacak şekilde üretimi başlat.
6. `wait_jobs` ile bekle, `view_post` ile sonuca bak; görsel yuvası boş kaldıysa `fill_post_slot` ile doldur.
7. Yanıtta postu kısaca anlat ve onay ya da düzeltme iste. Onay ve zamanlama yalnızca kullanıcı isterse ve izin kartıyla.
