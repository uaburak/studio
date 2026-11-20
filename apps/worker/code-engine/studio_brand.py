"""Studio's code engine helper (docs/URETIM-RESIM.md, Faz 4).

A post program imports this module to get the brand's inputs and to draw the things Studio
checks afterwards. Everything the worker hands over (the artboard, the safe area, the brand's
colours and font files, the pictures, the filled image slots, the output folder) is read from the
job's input JSON; nothing else on the machine is reachable from the sandbox.

    import studio_brand as sb
    img = sb.canvas(1, background="paper")
    sb.text(img, sb.SAFE_LEFT, 240, "Hasat zamanı", role="display", size=96, weight=800,
            color="ink", max_width=sb.SAFE_WIDTH, id="headline")
    sb.slot(img, 96, 560, 888, 666, ratio="4:3")          # an "AI görsel" filled after approval
    sb.save(img)

Every `text`, `place` and `slot` call is recorded (box, font, size, colour, the background under
the text) in `record.json` next to the PNGs: the worker's lint reads it (overflow, safe area,
minimum size, brand font, contrast, allowed numbers, slot ratio). Text drawn any other way is
invisible to the checks, so all copy goes through `text`.
"""

import atexit
import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

__all__ = [
    "W",
    "H",
    "SAFE",
    "SAFE_LEFT",
    "SAFE_TOP",
    "SAFE_RIGHT",
    "SAFE_BOTTOM",
    "SAFE_WIDTH",
    "SAFE_HEIGHT",
    "COLORS",
    "USAGE",
    "TYPE",
    "FONTS",
    "LANG",
    "ALLOWED_NUMBERS",
    "SLIDES",
    "OUTPUT_DIR",
    "color",
    "font",
    "font_path",
    "skia_typeface",
    "pictures",
    "picture",
    "canvas",
    "text",
    "measure",
    "fit_size",
    "place",
    "slot",
    "save",
    "linear_gradient",
    "radial_gradient",
    "rounded_mask",
    "noise",
    "shadow",
    "vignette",
    "skia_surface",
    "from_skia",
]

_INPUT_ENV = "STUDIO_CODE_INPUT"


def _load_input():
    path = os.environ.get(_INPUT_ENV)
    if not path:
        raise RuntimeError("studio_brand: the job input is missing (run through Studio)")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


_IN = _load_input()

W = int(_IN["artboard"]["width"])
H = int(_IN["artboard"]["height"])
SAFE = dict(_IN.get("safeArea") or {"top": 0, "right": 0, "bottom": 0, "left": 0})
SAFE_LEFT = int(SAFE["left"])
SAFE_TOP = int(SAFE["top"])
SAFE_RIGHT = W - int(SAFE["right"])
SAFE_BOTTOM = H - int(SAFE["bottom"])
SAFE_WIDTH = SAFE_RIGHT - SAFE_LEFT
SAFE_HEIGHT = SAFE_BOTTOM - SAFE_TOP
COLORS = dict(_IN.get("colors") or {})
USAGE = dict(_IN.get("usage") or {})
TYPE = dict(_IN.get("type") or {})
FONTS = dict(_IN.get("fonts") or {})
LANG = _IN.get("language") or "tr"
ALLOWED_NUMBERS = list(_IN.get("allowedNumbers") or [])
SLIDES = dict(_IN.get("slides") or {"min": 1, "max": 1})
OUTPUT_DIR = _IN["outputDir"]
_PICTURES = {p["name"]: p for p in (_IN.get("pictures") or [])}
_SLOT_PICTURES = dict(_IN.get("slots") or {})
_SYSTEM_FONT_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts"]

# --- the record the worker lints -----------------------------------------------------------

_record = {"version": 1, "slides": {}, "fonts": {}, "warnings": []}
_current = [1]


def _slide_record(n=None):
    key = str(n if n is not None else _current[0])
    return _record["slides"].setdefault(key, {"texts": [], "images": [], "slots": [], "saved": False})


def _write_record():
    try:
        tmp = os.path.join(OUTPUT_DIR, ".record.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_record, fh, ensure_ascii=False)
        os.replace(tmp, os.path.join(OUTPUT_DIR, "record.json"))
    except OSError:
        pass


atexit.register(_write_record)


def _warn(message):
    if len(_record["warnings"]) < 50:
        _record["warnings"].append(str(message)[:300])


# --- colours ---------------------------------------------------------------------------------


def color(value="ink", alpha=255):
    """A brand colour token ("ink", "accent"…), a usage name ("background", "text"…), "#RRGGBB"
    or an (r, g, b[, a]) tuple → (r, g, b, a)."""
    if isinstance(value, (tuple, list)):
        vals = [int(v) for v in value]
        if len(vals) == 3:
            vals.append(int(alpha))
        return tuple(vals[:4])
    name = str(value)
    if name in USAGE and USAGE[name] in COLORS:
        name = USAGE[name]
    hexv = COLORS.get(name, name)
    hexv = str(hexv).strip()
    if not hexv.startswith("#"):
        raise ValueError("unknown colour %r (brand colours: %s)" % (value, ", ".join(sorted(COLORS))))
    h = hexv[1:]
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) == 8:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(alpha))


def _rgb_css(rgba):
    return "rgb(%d, %d, %d)" % (rgba[0], rgba[1], rgba[2]) if rgba[3] >= 255 else "rgba(%d, %d, %d, %.3f)" % (
        rgba[0],
        rgba[1],
        rgba[2],
        rgba[3] / 255.0,
    )


# --- fonts -----------------------------------------------------------------------------------

_font_cache = {}
_system_cache = {}
_WEIGHT_NAMES = [
    (100, ("thin", "hairline")),
    (200, ("extralight", "ultralight")),
    (300, ("light",)),
    (400, ("regular", "normal", "book", "roman")),
    (500, ("medium",)),
    (600, ("semibold", "demibold")),
    (700, ("bold",)),
    (800, ("extrabold", "ultrabold", "heavy")),
    (900, ("black", "heavy")),
]


def _role(role):
    if role in FONTS:
        return role
    alias = USAGE.get(role) or USAGE.get(str(role) + "Font")
    if alias in FONTS:
        return alias
    if FONTS:
        raise ValueError("unknown font role %r (brand roles: %s)" % (role, ", ".join(sorted(FONTS))))
    raise ValueError("the brand has no fonts")


def _weight_of_style(style_name):
    s = (style_name or "").lower().replace(" ", "").replace("-", "")
    best = 400
    for w, names in _WEIGHT_NAMES:
        for n in names:
            if n in s:
                best = w
    return best


def _system_faces(family):
    """(path, index, style name) of an installed family (macOS system font folders)."""
    if family in _system_cache:
        return _system_cache[family]
    want = family.lower().replace(" ", "")
    first = family.lower().split(" ")[0]
    faces = []
    for d in _SYSTEM_FONT_DIRS:
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for name in names:
            low = name.lower()
            if not low.endswith((".ttf", ".otf", ".ttc")) or first not in low:
                continue
            path = os.path.join(d, name)
            for index in range(0, 32):
                try:
                    f = ImageFont.truetype(path, 12, index=index)
                except OSError:
                    break
                fam, style = f.getname()
                if (fam or "").lower().replace(" ", "") == want:
                    faces.append((path, index, style or ""))
                if not low.endswith(".ttc"):
                    break
    _system_cache[family] = faces
    return faces


def _candidates(role, weight, italic):
    """(path, index) of the role's faces, best first: the brand's files of the asked style
    closest to the weight (all unicode subsets of it, e.g. latin + latin-ext), then the rest;
    an installed family's faces when the role has no files."""
    spec = FONTS[role]
    files = spec.get("files") or []
    style = "italic" if italic else "normal"
    if files:
        same = [f for f in files if (f.get("style") or "normal") == style] or files

        def distance(f):
            w = f.get("weight")
            if isinstance(w, list) and len(w) == 2:
                if w[0] <= weight <= w[1]:
                    return 0
                return min(abs(weight - w[0]), abs(weight - w[1]))
            return abs((w if isinstance(w, (int, float)) else 400) - weight) if w is not None else 0

        ordered = sorted(same, key=distance)
        rest = [f for f in files if f not in ordered]
        return [(f["path"], 0) for f in ordered + rest]
    faces = _system_faces(spec.get("family") or "")
    if faces:
        wanted = [x for x in faces if ("italic" in x[2].lower()) == bool(italic)] or faces
        ordered = sorted(wanted, key=lambda x: abs(_weight_of_style(x[2]) - weight))
        return [(x[0], x[1]) for x in ordered]
    raise ValueError("no font file for role %r (%s)" % (role, spec.get("family")))


_coverage = {}


def _covers(path, index, ch):
    """Whether a font file has a glyph for the character (skia reads the cmap)."""
    key = (path, index, ch)
    if key in _coverage:
        return _coverage[key]
    try:
        import skia

        tf = _coverage.get((path, index))
        if tf is None:
            tf = skia.Typeface.MakeFromFile(path, index)
            _coverage[(path, index)] = tf
        ok = bool(tf) and tf.unicharsToGlyphs([ord(ch)])[0] != 0
    except Exception:
        ok = True
    _coverage[key] = ok
    return ok


def _default_weight(role):
    w = FONTS[role].get("defaultWeight")
    return int(w) if w else 400


def font_path(role="text", weight=None, italic=False):
    """The font file of a role (absolute path; for skia or OpenCV)."""
    r = _role(role)
    return _candidates(r, int(weight or _default_weight(r)), italic)[0][0]


def _load(path, index, size, weight):
    key = (path, index, int(round(size * 4)), weight)
    if key in _font_cache:
        return _font_cache[key]
    f = ImageFont.truetype(path, max(1, int(round(size))), index=index)
    try:
        axes = f.get_variation_axes()
    except (OSError, AttributeError):
        axes = []
    if axes:
        values = []
        for a in axes:
            name = a.get("name")
            name = name.decode("latin-1") if isinstance(name, bytes) else str(name)
            if name.lower().startswith("weight") or name.lower() == "wght":
                values.append(max(a["minimum"], min(a["maximum"], weight)))
            else:
                values.append(a["default"])
        try:
            f.set_variation_by_axes(values)
        except OSError:
            pass
    _font_cache[key] = f
    return f


def _note_font(role, path):
    family = FONTS[role].get("family") or os.path.basename(path)
    _record["fonts"][family] = {"family": family, "status": "loaded", "file": os.path.basename(path)}


def font(role="text", size=40, weight=None, italic=False):
    """A Pillow font of the brand role at `size` px; a variable font is set to `weight`. (A brand
    split into unicode subsets has more files: `text` picks the right one per character.)"""
    r = _role(role)
    weight = int(weight or _default_weight(r))
    path, index = _candidates(r, weight, italic)[0]
    _note_font(r, path)
    return _load(path, index, size, weight)


def _runs(s, role, size, weight, italic):
    """The line as runs of (text, font): each character in the first face that has it."""
    faces = _candidates(role, weight, italic)
    runs = []
    for ch in s:
        face = faces[0]
        if not ch.isspace():
            for cand in faces:
                if _covers(cand[0], cand[1], ch):
                    face = cand
                    break
        if runs and runs[-1][1] == face:
            runs[-1][0].append(ch)
        else:
            runs.append([[ch], face])
    out = []
    for chars, face in runs:
        _note_font(role, face[0])
        out.append(("".join(chars), _load(face[0], face[1], size, weight)))
    return out


def skia_typeface(role="text", weight=None, italic=False):
    """A skia Typeface of the brand role (for skia drawing; record the text with `text`)."""
    import skia

    r = _role(role)
    weight = int(weight or _default_weight(r))
    path, index = _candidates(r, weight, italic)[0]
    tf = skia.Typeface.MakeFromFile(path, index)
    if tf is None:
        raise ValueError("skia could not load %s" % path)
    return tf


# --- pictures --------------------------------------------------------------------------------


def pictures():
    """The pictures this post may use: [{name, kind, label, width, height, note}]."""
    return [
        {k: p.get(k) for k in ("name", "kind", "label", "width", "height", "note")}
        for p in _PICTURES.values()
    ]


def picture(name):
    """A listed picture as an RGBA Pillow image (`name` from `pictures()`, e.g. "@image")."""
    p = _PICTURES.get(name)
    if p is None:
        raise ValueError("unknown picture %r (listed: %s)" % (name, ", ".join(sorted(_PICTURES)) or "none"))
    return Image.open(p["path"]).convert("RGBA")


# --- slides ----------------------------------------------------------------------------------


def canvas(slide=1, background="background"):
    """Start slide `slide` (1-based): a new W×H RGBA image filled with `background` (a colour,
    or None for transparent). Everything recorded from now on belongs to this slide."""
    n = int(slide)
    if n < 1 or n > int(SLIDES.get("max", 10)):
        raise ValueError("slide %d is outside 1..%d" % (n, int(SLIDES.get("max", 10))))
    _current[0] = n
    _slide_record(n)
    fill = (0, 0, 0, 0) if background is None else color(background)
    return Image.new("RGBA", (W, H), fill)


def save(img, slide=None):
    """Write the slide as `slide-N.png` (exactly W×H; transparency flattened on white)."""
    n = int(slide if slide is not None else _current[0])
    if img.size != (W, H):
        raise ValueError("slide %d is %dx%d, it must be %dx%d" % (n, img.size[0], img.size[1], W, H))
    out = img
    if out.mode != "RGB":
        rgba = out.convert("RGBA")
        base = Image.new("RGBA", (W, H), (255, 255, 255, 255))
        base.alpha_composite(rgba)
        out = base.convert("RGB")
    out.save(os.path.join(OUTPUT_DIR, "slide-%d.png" % n), "PNG", optimize=False, compress_level=3)
    _slide_record(n)["saved"] = True
    _write_record()
    return n


# --- text ------------------------------------------------------------------------------------


class _Face(object):
    """A role at a size and weight: the runs of a line in the faces that have its characters."""

    def __init__(self, role, size, weight, italic):
        self.role, self.size, self.weight, self.italic = role, size, weight, italic
        self.primary = font(role, size, weight, italic)

    def runs(self, s):
        return _runs(s, self.role, self.size, self.weight, self.italic)


def _line_width(s, face, tracking_px):
    if not s:
        return 0.0
    if tracking_px:
        return sum(f.getlength(ch) for part, f in face.runs(s) for ch in part) + tracking_px * max(0, len(s) - 1)
    return sum(f.getlength(part) for part, f in face.runs(s))


def _wrap(text, f, max_width, tracking_px):
    out = []
    for para in str(text).split("\n"):
        words = para.split(" ")
        if max_width is None:
            out.append(para)
            continue
        line = ""
        for w in words:
            trial = w if not line else line + " " + w
            if _line_width(trial, f, tracking_px) <= max_width or not line:
                line = trial
            else:
                out.append(line)
                line = w
        out.append(line)
    return out


def _leading(role, line_height):
    if line_height:
        return float(line_height)
    for t in TYPE.values():
        if t.get("font") == role and t.get("leading"):
            return float(t["leading"])
    return 1.2


def _tracking_px(tracking, size):
    if isinstance(tracking, str) and tracking.endswith("em"):
        return float(tracking[:-2]) * size
    return float(tracking or 0) * size


def measure(text, role="text", size=40, weight=None, max_width=None, line_height=None, tracking=0, uppercase=False):
    """(width, height, lines) the text would take, without drawing it."""
    r = _role(role)
    weight = int(weight or _default_weight(r))
    f = _Face(r, size, weight, False)
    s = str(text).upper() if uppercase else str(text)
    tp = _tracking_px(tracking, size)
    lines = _wrap(s, f, max_width, tp)
    adv = size * _leading(r, line_height)
    asc, desc = f.primary.getmetrics()
    width = max([_line_width(x, f, tp) for x in lines] or [0])
    height = adv * (len(lines) - 1) + asc + desc
    return int(math.ceil(width)), int(math.ceil(height)), lines


def fit_size(text, role="text", max_width=None, max_height=None, start=96, minimum=28, weight=None, line_height=None, max_lines=None, tracking=0, uppercase=False):
    """The largest size (start → minimum, step 2) at which the text fits the box."""
    size = int(start)
    while size > minimum:
        w, h, lines = measure(text, role, size, weight, max_width, line_height, tracking, uppercase)
        if (max_width is None or w <= max_width) and (max_height is None or h <= max_height) and (
            max_lines is None or len(lines) <= max_lines
        ):
            return size
        size -= 2
    return int(minimum)


def _background_stats(img, box):
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(img.size[0], x1), min(img.size[1], y1)
    if x1 <= x0 or y1 <= y0:
        return None
    region = np.asarray(img.crop((x0, y0, x1, y1)).convert("RGB"), dtype=np.float64).reshape(-1, 3)
    if region.shape[0] > 40000:
        idx = np.linspace(0, region.shape[0] - 1, 40000).astype(np.int64)
        region = region[idx]
    lum = region[:, 0] * 0.2126 + region[:, 1] * 0.7152 + region[:, 2] * 0.0722
    order = np.argsort(lum)

    def pick(q):
        px = region[order[min(len(order) - 1, int(q * (len(order) - 1)))]]
        return [int(round(v)) for v in px]

    return {"median": pick(0.5), "dark": pick(0.05), "light": pick(0.95)}


def text(
    img,
    x,
    y,
    text,
    role="text",
    size=40,
    weight=None,
    color="text",
    max_width=None,
    align="left",
    line_height=None,
    tracking=0,
    id=None,
    uppercase=False,
    italic=False,
    opacity=1.0,
    shadow=None,
    legal=False,
    allow_overlap=False,
):
    """Draw (and record) a text block. `x` is the left edge (align="left"), the centre ("center")
    or the right edge ("right"); `y` is the top of the first line. Lines wrap at `max_width`
    (and at "\\n"). `tracking` in em (0.02) or "0.02em". `shadow` = (dx, dy, blur, colour).
    `allow_overlap=True` marks text meant to sit on other text (a large background numeral).
    Returns {x, y, w, h, lines, next_y}: the ink box of the drawn text and `next_y`, the bottom of
    its last line box (y + every line's advance), where the next text block may start."""
    r = _role(role)
    weight = int(weight or _default_weight(r))
    f = _Face(r, size, weight, italic)
    s = str(text).upper() if uppercase else str(text)
    tp = _tracking_px(tracking, size)
    lines = _wrap(s, f, max_width, tp)
    adv = size * _leading(r, line_height)
    rgba = globals()["color"](color)
    rgba = (rgba[0], rgba[1], rgba[2], int(round(rgba[3] * max(0.0, min(1.0, float(opacity))))))
    draw_probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    placed = []
    for i, line in enumerate(lines):
        lw = _line_width(line, f, tp)
        lx = x if align == "left" else (x - lw / 2.0 if align == "center" else x - lw)
        ly = y + i * adv
        placed.append((lx, ly, line, lw))
    # The ink box (glyph extents) of every line.
    boxes = []
    for lx, ly, line, lw in placed:
        if not line.strip():
            continue
        cx = lx
        for part, pf in f.runs(line):
            if part.strip():
                b = draw_probe.textbbox((cx, ly), part, font=pf, anchor="la")
                boxes.append((b[0], b[1], max(b[2], cx + _line_width(part, f, tp)), b[3]))
            cx += _line_width(part, f, tp) + (tp if tp else 0)
    if not boxes:
        return {"x": int(x), "y": int(y), "w": 0, "h": 0, "lines": 0, "next_y": int(y)}
    bx0 = min(b[0] for b in boxes)
    by0 = min(b[1] for b in boxes)
    bx1 = max(b[2] for b in boxes)
    by1 = max(b[3] for b in boxes)
    stats = _background_stats(img, (bx0, by0, bx1, by1))
    # The line boxes: the space the wrapped block takes with its line spacing, every line's
    # advance (and at least the font's ascent + descent for the last one). Another block set
    # inside it collides with this text even when the glyphs themselves do not touch.
    asc, desc = f.primary.getmetrics()
    line_top = min(float(y), by0)
    line_bottom = max(float(y) + adv * (len(lines) - 1) + max(adv, float(asc + desc)), by1)

    pad = int(size) + (int(shadow[2]) * 3 + int(abs(shadow[0]) + abs(shadow[1])) if shadow else 0)
    ox, oy = int(math.floor(bx0)) - pad, int(math.floor(by0)) - pad
    lw_, lh_ = int(math.ceil(bx1 - bx0)) + 2 * pad, int(math.ceil(by1 - by0)) + 2 * pad
    layer = Image.new("RGBA", (max(1, lw_), max(1, lh_)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for lx, ly, line, _lw in placed:
        cx = lx - ox
        for part, pf in f.runs(line):
            if tp == 0:
                d.text((cx, ly - oy), part, font=pf, fill=rgba, anchor="la")
                cx += pf.getlength(part)
            else:
                for ch in part:
                    d.text((cx, ly - oy), ch, font=pf, fill=rgba, anchor="la")
                    cx += pf.getlength(ch) + tp
    if shadow:
        dx, dy, blur, scol = shadow
        sc = globals()["color"](scol)
        alpha = layer.getchannel("A").filter(ImageFilter.GaussianBlur(max(0.0, float(blur))))
        alpha = alpha.point(lambda v: int(v * sc[3] / 255))
        sh = Image.new("RGBA", layer.size, (sc[0], sc[1], sc[2], 0))
        sh.putalpha(alpha)
        moved = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        moved.paste(sh, (int(dx), int(dy)))
        moved.alpha_composite(layer)
        layer = moved
    _composite(img, layer, (ox, oy))

    tid = id or "text-%d" % (len(_slide_record()["texts"]) + 1)
    _slide_record()["texts"].append(
        {
            "id": str(tid)[:64],
            "text": s.replace("\n", " ")[:2000],
            "rect": {"x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0},
            "fontSize": float(size),
            "weight": str(weight),
            "family": FONTS[r].get("family") or f.primary.getname()[0],
            "role": r,
            "color": _rgb_css(rgba),
            "lines": len([ln for ln in lines if ln.strip()]) or 1,
            "legal": bool(legal),
            "background": stats,
            "maxWidth": max_width,
            "lineBox": {"x": bx0, "y": line_top, "w": bx1 - bx0, "h": line_bottom - line_top},
            "allowOverlap": bool(allow_overlap),
        }
    )
    return {
        "x": int(bx0),
        "y": int(by0),
        "w": int(math.ceil(bx1 - bx0)),
        "h": int(math.ceil(by1 - by0)),
        "lines": len(lines),
        "next_y": int(math.ceil(line_bottom)),
    }


def _composite(img, layer, pos):
    """Blend an RGBA layer onto an RGB or RGBA image at pos (may hang over the edges)."""
    x, y = int(pos[0]), int(pos[1])
    if img.mode == "RGBA":
        # alpha_composite needs the layer inside the image: crop what hangs over.
        cx0, cy0 = max(0, -x), max(0, -y)
        cx1 = min(layer.size[0], img.size[0] - x)
        cy1 = min(layer.size[1], img.size[1] - y)
        if cx1 <= cx0 or cy1 <= cy0:
            return
        img.alpha_composite(layer.crop((cx0, cy0, cx1, cy1)), (x + cx0, y + cy0))
    else:
        img.paste(layer.convert(img.mode), (x, y), layer)


# --- pictures and slots ----------------------------------------------------------------------


def rounded_mask(w, h, radius):
    """An "L" mask of a w×h rounded rectangle."""
    m = Image.new("L", (int(w), int(h)), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, int(w) - 1, int(h) - 1), radius=int(radius), fill=255)
    return m


def _fit_picture(pic, w, h, fit, focus):
    w, h = int(round(w)), int(round(h))
    if fit == "contain":
        s = min(w / pic.size[0], h / pic.size[1])
        resized = pic.resize((max(1, int(round(pic.size[0] * s))), max(1, int(round(pic.size[1] * s)))), Image.LANCZOS)
        out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        out.alpha_composite(resized, ((w - resized.size[0]) // 2, (h - resized.size[1]) // 2))
        return out
    s = max(w / pic.size[0], h / pic.size[1])
    rw, rh = max(w, int(math.ceil(pic.size[0] * s))), max(h, int(math.ceil(pic.size[1] * s)))
    resized = pic.resize((rw, rh), Image.LANCZOS)
    fx, fy = focus
    left = int(round((rw - w) * fx))
    top = int(round((rh - h) * fy))
    return resized.crop((left, top, left + w, top + h))


def place(img, name, x, y, w, h, fit="cover", radius=0, opacity=1.0, focus=(0.5, 0.5), id=None):
    """Draw a listed picture into the box (cover: fills and crops; contain: fits whole, for
    logos). Never stretched. Returns the box."""
    p = _PICTURES.get(name)
    pic = picture(name)
    tile = _fit_picture(pic, w, h, fit, focus)
    if radius:
        mask = ImageChops.multiply(tile.getchannel("A"), rounded_mask(tile.size[0], tile.size[1], radius))
        tile.putalpha(mask)
    if opacity < 1:
        tile.putalpha(tile.getchannel("A").point(lambda v: int(v * max(0.0, float(opacity)))))
    _composite(img, tile, (int(round(x)), int(round(y))))
    kind = (p or {}).get("kind") or "image"
    _slide_record()["images"].append(
        {
            "id": str(id or "%s-%d" % ("logo" if kind == "logo" else "image", len(_slide_record()["images"]) + 1))[:64],
            "name": name,
            "kind": kind,
            "rect": {"x": float(x), "y": float(y), "w": float(w), "h": float(h)},
            "fit": fit,
        }
    )
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


def _ratio(value):
    try:
        a, b = str(value).replace("/", ":").replace("x", ":").split(":")
        a, b = float(a), float(b)
        return (a, b) if a > 0 and b > 0 else None
    except ValueError:
        return None


def slot(img, x, y, w, h, ratio="4:5", label="AI görsel", id="ai-image", radius=0, fill=None):
    """An image slot filled later (the approved AI picture): a quiet placeholder now; when Studio
    re-runs the program with the approved picture, it is drawn here (cover-cropped). Its width:height
    must equal `ratio`. Never put text over it."""
    sid = str(id)[:64]
    assigned = _SLOT_PICTURES.get(sid)
    if assigned:
        pic = Image.open(assigned).convert("RGBA")
        tile = _fit_picture(pic, w, h, "cover", (0.5, 0.5))
        if radius:
            tile.putalpha(ImageChops.multiply(tile.getchannel("A"), rounded_mask(tile.size[0], tile.size[1], radius)))
        _composite(img, tile, (int(round(x)), int(round(y))))
    else:
        base = globals()["color"](fill or USAGE.get("slotFill") or ("mist" if "mist" in COLORS else (236, 236, 232)))
        tile = Image.new("RGBA", (max(1, int(round(w))), max(1, int(round(h)))), base)
        if radius:
            tile.putalpha(rounded_mask(tile.size[0], tile.size[1], radius))
        _composite(img, tile, (int(round(x)), int(round(y))))
    _slide_record()["slots"].append(
        {
            "id": sid,
            "state": "filled" if assigned else "empty",
            "ratio": str(ratio) if ratio else None,
            "label": label,
            "rect": {"x": float(x), "y": float(y), "w": float(w), "h": float(h)},
            "radius": float(radius or 0),
        }
    )
    r = _ratio(ratio)
    if r and h > 0 and abs((w / float(h)) / (r[0] / r[1]) - 1) > 0.02:
        _warn("slot %s is %dx%d but declares %s" % (sid, w, h, ratio))
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


# --- effects ---------------------------------------------------------------------------------


def _stops(stops):
    out = []
    for i, s in enumerate(stops):
        if isinstance(s, (tuple, list)) and len(s) == 2 and isinstance(s[0], (int, float)):
            out.append((float(s[0]), color(s[1])))
        else:
            out.append((i / max(1, len(stops) - 1), color(s)))
    return sorted(out, key=lambda t: t[0])


def _ramp(t, stops):
    t = np.clip(t, 0.0, 1.0)
    pos = np.array([s[0] for s in stops])
    out = np.zeros(t.shape + (4,), dtype=np.float64)
    for k in range(4):
        out[..., k] = np.interp(t, pos, np.array([s[1][k] for s in stops], dtype=np.float64))
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


def linear_gradient(w, h, stops, angle=90):
    """An RGBA gradient (angle in degrees: 90 = top → bottom, 0 = left → right)."""
    w, h = int(w), int(h)
    a = math.radians(angle)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    dx, dy = math.cos(a), math.sin(a)
    proj = (xx - w / 2.0) * dx + (yy - h / 2.0) * dy
    span = abs(w * dx) / 2.0 + abs(h * dy) / 2.0 or 1.0
    return _ramp((proj / span + 1) / 2.0, _stops(stops))


def radial_gradient(w, h, stops, center=(0.5, 0.5), radius=None):
    """An RGBA radial gradient (center as fractions; radius in px, default to the far corner)."""
    w, h = int(w), int(h)
    cx, cy = center[0] * w, center[1] * h
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    rad = radius or math.hypot(max(cx, w - cx), max(cy, h - cy))
    return _ramp(np.hypot(xx - cx, yy - cy) / rad, _stops(stops))


def noise(img, amount=0.04, seed=7, monochrome=True):
    """Film grain over the image (returns a new image)."""
    rng = np.random.default_rng(seed)
    arr = np.asarray(img.convert("RGBA"), dtype=np.float64)
    shape = arr.shape[:2] + ((1,) if monochrome else (3,))
    grain = rng.normal(0.0, 255.0 * float(amount), shape)
    arr[..., :3] = np.clip(arr[..., :3] + grain, 0, 255)
    out = Image.fromarray(arr.astype(np.uint8), "RGBA")
    return out if img.mode == "RGBA" else out.convert(img.mode)


def shadow(layer, blur=24, colour=(0, 0, 0, 90), spread=0):
    """The soft shadow of an RGBA layer's shape (same size): composite it under the layer."""
    c = color(colour)
    a = layer.getchannel("A")
    if spread:
        a = a.filter(ImageFilter.MaxFilter(int(spread) * 2 + 1))
    a = a.filter(ImageFilter.GaussianBlur(float(blur))).point(lambda v: int(v * c[3] / 255))
    out = Image.new("RGBA", layer.size, (c[0], c[1], c[2], 0))
    out.putalpha(a)
    return out


def vignette(img, strength=0.35):
    """Darken the edges (returns a new image)."""
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    d = np.hypot((xx - w / 2.0) / (w / 2.0), (yy - h / 2.0) / (h / 2.0)) / math.sqrt(2)
    f = 1.0 - float(strength) * np.clip(d, 0, 1) ** 2
    arr = np.asarray(img.convert("RGBA"), dtype=np.float64)
    arr[..., :3] *= f[..., None]
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
    return out if img.mode == "RGBA" else out.convert(img.mode)


def skia_surface(w=None, h=None):
    """A skia raster surface (W×H by default) and its canvas: (surface, canvas)."""
    import skia

    surface = skia.Surface(int(w or W), int(h or H))
    return surface, surface.getCanvas()


def from_skia(surface_or_image):
    """A skia Surface/Image → an RGBA Pillow image."""
    import skia

    image = surface_or_image.makeImageSnapshot() if hasattr(surface_or_image, "makeImageSnapshot") else surface_or_image
    arr = image.toarray(colorType=skia.ColorType.kRGBA_8888_ColorType, alphaType=skia.AlphaType.kUnpremul_AlphaType)
    return Image.fromarray(arr, "RGBA")


# A reproducible random for programs that want it.
random.seed(_IN.get("seed", 7))
