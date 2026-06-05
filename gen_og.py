#!/usr/bin/env python3
"""
Generate the Pintag homepage OG image (1200×630px).
Split layout: left = villa photo, right = dark brand panel with Lao text.
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import textwrap, os

# ── Canvas ─────────────────────────────────────────────────────────────────
W, H = 1200, 630
SPLIT = 696          # left panel width (58 %)

# ── Brand colours ──────────────────────────────────────────────────────────
DARK       = (26,  32,  36)
DARK_SOFT  = (36,  46,  52)
WARM       = (247, 243, 236)
TEAL       = (45,  140, 140)
TEAL_LIGHT = (56,  168, 168)
WHITE      = (255, 255, 255)
WHITE_DIM  = (255, 255, 255, 190)
GOLD       = (200, 165, 90)
CREAM      = (243, 239, 232)

# ── Font paths ──────────────────────────────────────────────────────────────
LAO_B  = "/usr/share/fonts/truetype/noto/NotoSansLao-Bold.ttf"
LAO_R  = "/usr/share/fonts/truetype/noto/NotoSansLao-Regular.ttf"
SAN_B  = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SAN_R  = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def load(path, size):
    return ImageFont.truetype(path, size)

f_logo      = load(SAN_B,  34)
f_tag       = load(SAN_R,  16)
f_headline  = load(LAO_B,  52)
f_sub       = load(LAO_R,  22)
f_url       = load(SAN_B,  17)
f_card_t    = load(LAO_R,  18)
f_card_p    = load(SAN_B,  16)
f_badge     = load(SAN_B,  13)
f_small     = load(SAN_R,  14)

# ── Helpers ─────────────────────────────────────────────────────────────────
def text_w(draw, text, font):
    bb = draw.textbbox((0, 0), text, font=font)
    return bb[2] - bb[0]

def text_h(draw, text, font):
    bb = draw.textbbox((0, 0), text, font=font)
    return bb[3] - bb[1]

def draw_rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill)

def crop_fill(img, target_w, target_h):
    """Centre-crop an image to exact dimensions."""
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    new_w, new_h = int(src_w * scale), int(src_h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top  = (new_h - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))

# ── Base canvas ─────────────────────────────────────────────────────────────
canvas = Image.new("RGB", (W, H), DARK)

# ── LEFT PANEL: property photo ───────────────────────────────────────────────
villa = Image.open("/home/user/pintag/pintag-villa.png").convert("RGB")
villa = crop_fill(villa, SPLIT, H)
canvas.paste(villa, (0, 0))

# Dark gradient on the right edge of the photo (smooth blend into dark panel)
grad_w = 160
for x in range(grad_w):
    alpha = int(255 * (x / grad_w) ** 0.55)
    col = (
        int(DARK[0] * alpha / 255),
        int(DARK[1] * alpha / 255),
        int(DARK[2] * alpha / 255),
    )
    canvas.paste(
        Image.new("RGB", (1, H), col),
        (SPLIT - grad_w + x, 0)
    )

# Light dark vignette on top + bottom of photo for depth
for y in range(80):
    a = int(180 * (1 - y / 80))
    strip = Image.new("RGB", (SPLIT, 1),
                      tuple(int(c + (0 - c) * a / 255) for c in DARK))
    # skip - just use a simple overlay
for y in range(100):
    a = int(140 * (1 - y / 100))
    col = tuple(int(DARK[i] * a / 255 + villa.getpixel((SPLIT // 2, H - 100 + y))[i] * (255 - a) / 255) for i in range(3))

# ── RIGHT PANEL: dark brand panel ───────────────────────────────────────────
rp_x = SPLIT                # panel starts here
rp_w = W - SPLIT            # 504 px
pad  = 48                   # horizontal padding
text_x = rp_x + pad        # text left edge  (=744)
max_tw = rp_w - pad * 2     # max text width  (=408)

canvas_draw = ImageDraw.Draw(canvas)
canvas_draw.rectangle([(SPLIT, 0), (W, H)], fill=DARK)

# Subtle warm divider line
canvas_draw.rectangle([(SPLIT, 0), (SPLIT + 1, H)], fill=(60, 80, 90))

# ── Pintag logo mark (top of right panel) ────────────────────────────────────
logo_y = 52

# Pin circle background
pin_r   = 18
pin_cx  = text_x + pin_r
pin_cy  = logo_y + pin_r - 2
canvas_draw.ellipse(
    [pin_cx - pin_r, pin_cy - pin_r, pin_cx + pin_r, pin_cy + pin_r],
    fill=TEAL
)
# Pin letter "P"
p_char = "P"
p_w = text_w(canvas_draw, p_char, load(SAN_B, 20))
canvas_draw.text(
    (pin_cx - p_w // 2, pin_cy - 12),
    p_char, font=load(SAN_B, 20), fill=WHITE
)

# "Pintag" wordmark
logo_tx = pin_cx + pin_r + 10
canvas_draw.text((logo_tx, logo_y), "Pintag", font=f_logo, fill=WHITE)

# Tagline under logo
tag_y = logo_y + 44
canvas_draw.text(
    (text_x, tag_y),
    "Real Estate · Laos",
    font=f_tag,
    fill=(120, 160, 170)
)

# ── Divider ──────────────────────────────────────────────────────────────────
div_y = tag_y + 30
canvas_draw.rectangle(
    [(text_x, div_y), (text_x + 48, div_y + 2)],
    fill=TEAL
)

# ── Headline (Lao, 2 lines) ──────────────────────────────────────────────────
headline_y = div_y + 22

# "ທຸກຂໍ້ມູນຊັບສິນ"  line 1
line1 = "ທຸກຂໍ້ມູນຊັບສິນ"
# "ຢູ່ໃນລິ້ງດຽວ"      line 2
line2 = "ຢູ່ໃນລິ້ງດຽວ"

line_h = text_h(canvas_draw, line1, f_headline)

canvas_draw.text((text_x, headline_y),          line1, font=f_headline, fill=WHITE)
canvas_draw.text((text_x, headline_y + line_h + 8), line2, font=f_headline, fill=TEAL_LIGHT)

# ── Sub-description (Lao) ────────────────────────────────────────────────────
sub_y = headline_y + (line_h + 8) * 2 + 18
sub1  = "ຮູບພາບ · ວິດີໂອ · ແຜນທີ່ · ຂໍ້ມູນຕິດຕໍ່"
sub2  = "ທັງໝົດຢູ່ໃນລິ້ງດຽວ"
canvas_draw.text((text_x, sub_y),      sub1, font=f_sub, fill=(180, 200, 210))
canvas_draw.text((text_x, sub_y + 32), sub2, font=f_sub, fill=(180, 200, 210))

# ── Mock listing card ────────────────────────────────────────────────────────
card_y  = sub_y + 88
card_h  = 90
card_w  = max_tw
card_x  = text_x
card_img_w = 80

# Card background
draw_rounded_rect(
    canvas_draw,
    (card_x, card_y, card_x + card_w, card_y + card_h),
    radius=8,
    fill=(36, 48, 56)
)

# Card thumbnail
thumb = Image.open("/home/user/pintag/pintag-interior.png").convert("RGB")
thumb = crop_fill(thumb, card_img_w, card_h - 16)
thumb_x = card_x + 10
thumb_y = card_y + 8
# round the thumb corners with a mask
thumb_canvas = Image.new("RGB", thumb.size, (36, 48, 56))
mask = Image.new("L", thumb.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, thumb.width, thumb.height], radius=5, fill=255)
thumb_canvas.paste(thumb, (0, 0), mask)
canvas.paste(thumb_canvas, (thumb_x, thumb_y))

# Card text
tx = thumb_x + card_img_w + 12
ty = card_y + 12

cd = ImageDraw.Draw(canvas)
cd.text((tx, ty),      "ວຽງຈັນ · ໂຮງຊານ 3 ຫ້ອງ",
                        font=f_card_t, fill=(200, 220, 225))
cd.text((tx, ty + 26), "$145,000",
                        font=f_card_p, fill=WHITE)

# Teal dot + "Pintag listing"
dot_x = tx
dot_y = ty + 56
cd.ellipse([dot_x, dot_y + 3, dot_x + 8, dot_y + 11], fill=TEAL_LIGHT)
cd.text((dot_x + 14, dot_y), "Verified · pintag.io", font=f_small, fill=(100, 160, 170))

# ── Bottom bar ───────────────────────────────────────────────────────────────
bar_y = H - 52
canvas_draw.rectangle([(SPLIT, bar_y), (W, H)], fill=(20, 26, 30))

# URL
url_text = "pintag.io"
url_tw   = text_w(canvas_draw, url_text, f_url)
canvas_draw.text(
    (text_x, bar_y + 17),
    url_text,
    font=f_url,
    fill=(100, 160, 170)
)

# "ແພລດຟອມອະສັງຫາລິມະຊັບ ລາວ" label on the right of bottom bar
badge_text = "ລາວ · Real Estate Platform"
bt_w = text_w(canvas_draw, badge_text, f_badge)
canvas_draw.text(
    (W - pad - bt_w, bar_y + 19),
    badge_text,
    font=f_badge,
    fill=(80, 110, 120)
)

# ── Photo corner pill ────────────────────────────────────────────────────────
# Small "Property · Laos" pill over the photo
pill_x, pill_y = 24, 24
pill_text = "Property · Laos"
pill_tw   = text_w(canvas_draw, pill_text, f_badge)
draw_rounded_rect(
    canvas_draw,
    (pill_x - 10, pill_y - 6, pill_x + pill_tw + 10, pill_y + 20),
    radius=12,
    fill=(0, 0, 0, 0)   # won't be semi-transparent with RGB mode
)
# Use RGBA for overlay pill
overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
od.rounded_rectangle(
    [pill_x - 10, pill_y - 6, pill_x + pill_tw + 10, pill_y + 20],
    radius=12,
    fill=(0, 0, 0, 160)
)
canvas_rgba = canvas.convert("RGBA")
canvas_rgba = Image.alpha_composite(canvas_rgba, overlay)
canvas = canvas_rgba.convert("RGB")
canvas_draw = ImageDraw.Draw(canvas)
canvas_draw.text((pill_x, pill_y), pill_text, font=f_badge, fill=(220, 240, 245))

# ── Save ─────────────────────────────────────────────────────────────────────
out = "/home/user/pintag/og-homepage.png"
canvas.save(out, "PNG", optimize=True)
print(f"Saved {out}  ({os.path.getsize(out)//1024} KB)")
