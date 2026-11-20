import studio_brand as sb
from PIL import Image, ImageDraw, ImageFilter

# 1. Tuval oluşturma
img = sb.canvas(1, background="paper")
draw = ImageDraw.Draw(img)

# 2. Üst Başlık ve Manşet Alanı (Sol kenar: 72px)
sb.text(
    img,
    72,
    80,
    "VENTA SERİSİ · BİTKİ BESLEME",
    role="text",
    size=24,
    weight=700,
    color="accent",
    uppercase=True,
    tracking=0.1
)

sb.text(
    img,
    72,
    120,
    "Bor Eksikliği\nMeyve Tutumunu\nEngellemesin.",
    role="display",
    size=64,
    weight=700,
    color="ink",
    line_height=1.06,
    max_width=936
)

# Marka Vurgu Çizgisi
draw.rectangle([(72, 342), (72 + 56, 342 + 5)], fill=sb.color("accent"))

# Giriş Açıklaması
lead_text = (
    "Çiçeklenme ve döllenme evresinde bor noksanlığı, doğrudan meyve tutumunu ve "
    "rekolteyi sınırlar. Venta Boro, suda çözünür bor etanolamin formülasyonu ile bitki "
    "dokularına hızla ulaşır; döllenmeyi ve verimi destekler."
)
sb.text(
    img,
    72,
    368,
    lead_text,
    role="text",
    size=28,
    weight=400,
    color="graphite",
    max_width=936,
    line_height=1.38
)

# 3. Sağ Taraf: Ürün Vitrin Paneli (Product Staging Panel)
panel_x = 552
panel_y = 512
panel_w = 456
panel_h = 676

draw.rounded_rectangle(
    [panel_x, panel_y, panel_x + panel_w, panel_y + panel_h],
    radius=20,
    fill=sb.color("mist"),
    outline=sb.color("line"),
    width=1
)

# Panel Üst Rozeti
pill_w = 260
pill_h = 38
pill_x = panel_x + (panel_w - pill_w) // 2
pill_y = panel_y + 28

draw.rounded_rectangle(
    [pill_x, pill_y, pill_x + pill_w, pill_y + pill_h],
    radius=19,
    fill=sb.color("accent-deep")
)

sb.text(
    img,
    pill_x + pill_w // 2,
    pill_y + 8,
    "BOR ETANOLAMİN",
    role="text",
    size=24,
    weight=700,
    color="paper",
    align="center",
    tracking=0.06
)

# Ürün Zemin Gölgesi
shadow_layer = Image.new("RGBA", (sb.W, sb.H), (0, 0, 0, 0))
sdraw = ImageDraw.Draw(shadow_layer)
sdraw.ellipse([(780 - 150, 1105 - 14), (780 + 150, 1105 + 14)], fill=(30, 45, 40, 60))
shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(16))
img.alpha_composite(shadow_layer)

# Ürün Ambalajı
canister_x = panel_x + 24
canister_y = panel_y + 82
canister_w = 408
canister_h = 510
sb.place(img, "product/venta-boro-1", canister_x, canister_y, canister_w, canister_h, fit="contain")

# Panel Alt Vurgusu
sb.text(
    img,
    panel_x + panel_w // 2,
    panel_y + panel_h - 46,
    "Sıvı Formülasyon · Yüksek Emilim",
    role="text",
    size=24,
    weight=700,
    color="accent-deep",
    align="center"
)

# 4. Sol Taraf: Editoryal Bilgi Blokları
features = [
    {
        "y": 520,
        "tag": "İÇERİK VE FORMÜL",
        "title": "Suda Çözünür Bor",
        "desc": "Bitki dokularınca hızla emilen bor etanolamin yapısı, noksanlığı gecikmeden giderir.",
        "divider": 726
    },
    {
        "y": 746,
        "tag": "UYGULAMA YÖNTEMİ",
        "title": "Çift Yönlü Besleme",
        "desc": "Yapraktan püskürtme ve damla sulama sistemleriyle tam uyumlu pratik kullanım sunar.",
        "divider": 952
    },
    {
        "y": 972,
        "tag": "VERİM VE KALİTE",
        "title": "Meyve Tutumu Desteği",
        "desc": "Çiçeklenme ve polen canlılığını destekleyerek döllenmeyi ve meyve bağlamayı güçlendirir.",
        "divider": None
    }
]

for item in features:
    fy = item["y"]
    sb.text(img, 72, fy, item["tag"], role="text", size=24, weight=700, color="accent", uppercase=True, tracking=0.08)
    sb.text(img, 72, fy + 32, item["title"], role="text", size=32, weight=700, color="ink")
    sb.text(img, 72, fy + 74, item["desc"], role="text", size=28, weight=400, color="graphite", max_width=440, line_height=1.35)
    if item["divider"]:
        draw.line([(72, item["divider"]), (72 + 440, item["divider"])], fill=sb.color("line"), width=1)

# 5. Alt Bilgi Çizgisi ve Dipnotlar (Footer)
draw.line([(72, 1226), (1008, 1226)], fill=sb.color("line"), width=1)
sb.text(img, 72, 1244, "Venta Boro · Bor Etanolamin Çözeltisi", role="text", size=24, weight=500, color="stone")
sb.text(img, 1008, 1244, "Yapraktan ve Damla Sulamayla", role="text", size=24, weight=500, color="stone", align="right")

# 6. Kaydet
sb.save(img, 1)
