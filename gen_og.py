#!/usr/bin/env python3
"""
Pintag OG image generator — "Platform Window" layout
1200×630 px · JPEG 90q

Layout:
  • Dark canvas (#1A2428) with subtle dot texture
  • Floating Pintag listing card (photo panel left + UI info panel right)
  • Photo thumbnail rail below card (shows gallery richness)
  • Large Lao headline centred below card
  • Subtle pintag.io URL
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

# ── Canvas ────────────────────────────────────────────────────────────────────
W, H = 1200, 630

# ── Brand colours ─────────────────────────────────────────────────────────────
BG       = (26,  32,  36)
WARM     = (243, 239, 232)
WARMD    = (228, 223, 214)
WHITE    = (255, 255, 255)
TEAL     = (45,  140, 140)
TEAL_LT  = (56,  168, 168)
TEAL_DK  = (35,  107, 107)
INK      = (26,  36,  40)
SOFT     = (58,  78,  85)
MUTED    = (122, 144, 152)

# ── Font paths ─────────────────────────────────────────────────────────────────
LAO_B = "/usr/share/fonts/truetype/noto/NotoSansLao-Bold.ttf"
LAO_R = "/usr/share/fonts/truetype/noto/NotoSansLao-Regular.ttf"
SAN_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SAN_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def f(path, size):
    return ImageFont.truetype(path, size)

# ── Measurement helpers ────────────────────────────────────────────────────────
_scratch = ImageDraw.Draw(Image.new("L", (1, 1)))

def tw(text, font):
    bb = _scratch.textbbox((0, 0), text, font=font)
    return bb[2] - bb[0]

def th(text, font):
    bb = _scratch.textbbox((0, 0), text, font=font)
    return bb[3] - bb[1]

# ── Mixed-script text renderer ─────────────────────────────────────────────────
# NotoSansLao has NO ASCII/Latin glyphs.  Any string mixing Lao + Latin must
# be drawn segment-by-segment, switching fonts per Unicode block.

def _lao_runs(text):
    """Yield (segment, is_lao) pairs split at Lao/non-Lao boundaries."""
    runs, cur, cur_is = [], "", None
    for ch in text:
        is_lao = 0x0E80 <= ord(ch) <= 0x0EFF
        if cur_is is None:
            cur_is = is_lao
        if is_lao == cur_is:
            cur += ch
        else:
            runs.append((cur, cur_is))
            cur, cur_is = ch, is_lao
    if cur:
        runs.append((cur, cur_is))
    return runs

def draw_mixed(draw, x, y, text, f_lao, f_lat, fill, y_lat_offset=0):
    """Draw mixed Lao/Latin text.  Returns final x."""
    for seg, is_lao in _lao_runs(text):
        font = f_lao if is_lao else f_lat
        seg_y = y if is_lao else y + y_lat_offset
        draw.text((x, seg_y), seg, font=font, fill=fill)
        bb = draw.textbbox((x, seg_y), seg, font=font)
        x += bb[2] - bb[0]
    return x

def mixed_tw(text, f_lao, f_lat):
    """Pixel width of mixed-script text."""
    total = 0
    for seg, is_lao in _lao_runs(text):
        font = f_lao if is_lao else f_lat
        bb = _scratch.textbbox((0, 0), seg, font=font)
        total += bb[2] - bb[0]
    return total

# ── Image utilities ────────────────────────────────────────────────────────────
def crop_fill(img, w, h):
    scale = max(w / img.width, h / img.height)
    nw = int(img.width * scale)
    nh = int(img.height * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    return img.crop(((nw - w) // 2, (nh - h) // 2,
                     (nw - w) // 2 + w, (nh - h) // 2 + h))

def circle_crop(img, size):
    img = crop_fill(img.convert("RGB"), size, size)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img.convert("RGBA"), (0, 0), mask)
    return out

def paste_rgba(base, overlay, pos):
    tmp = Image.new("RGBA", base.size, (0, 0, 0, 0))
    tmp.paste(overlay, pos)
    return Image.alpha_composite(base, tmp)

# ── Card geometry ──────────────────────────────────────────────────────────────
CX, CY  = 50, 38
CW, CH  = 1100, 320
PHOTO_W = int(CW * 0.572)   # 629 px
INFO_W  = CW - PHOTO_W      # 471 px
CARD_R  = 12

# ── Base canvas ────────────────────────────────────────────────────────────────
canvas = Image.new("RGBA", (W, H), (*BG, 255))

# Subtle dot texture on background
tx = Image.new("RGBA", (W, H), (0, 0, 0, 0))
td = ImageDraw.Draw(tx)
for gy in range(0, H, 28):
    for gx in range(0, W, 28):
        td.ellipse([gx - 1, gy - 1, gx + 1, gy + 1], fill=(*TEAL, 16))
canvas = Image.alpha_composite(canvas, tx)

# ── Photo panel ────────────────────────────────────────────────────────────────
villa = Image.open("/home/user/pintag/pintag-villa.png").convert("RGB")
photo = crop_fill(villa, PHOTO_W, CH).convert("RGBA")

# Bottom gradient (dark vignette for text legibility)
grad = Image.new("RGBA", (PHOTO_W, CH), (0, 0, 0, 0))
gd   = ImageDraw.Draw(grad)
fade_top = int(CH * 0.52)
for y in range(CH - fade_top):
    a = int(205 * (y / (CH - fade_top)) ** 1.4)
    gd.rectangle([0, fade_top + y, PHOTO_W, fade_top + y + 1], fill=(0, 0, 0, a))

# Right-edge fade into cream info panel
for x in range(80):
    a = int(255 * (x / 80) ** 0.6)
    gd.rectangle([PHOTO_W - 80 + x, 0, PHOTO_W - 80 + x + 1, CH], fill=(*WARM, a))

photo = Image.alpha_composite(photo, grad)

# White corner bracket  (matches listing.html .dg-hero::before)
pd = ImageDraw.Draw(photo)
B, bs = 14, 18
pd.rectangle([B, B, B + bs, B + 1],  fill=(255, 255, 255, 75))
pd.rectangle([B, B, B + 1, B + bs],  fill=(255, 255, 255, 75))

# Photo-count pill  "8 ຮູບ"  — "8 " in SAN_R, "ຮູບ" in LAO_R
f_pc_lat = f(SAN_R, 11)
f_pc_lao = f(LAO_R, 11)
pc_lat, pc_lao = "8 ", "ຮູບ"
pcw = tw(pc_lat, f_pc_lat) + tw(pc_lao, f_pc_lao) + 18
pch = 20
pcx, pcy = PHOTO_W - pcw - 10, 10
pill = Image.new("RGBA", (pcw, pch), (0, 0, 0, 0))
ImageDraw.Draw(pill).rounded_rectangle([0, 0, pcw - 1, pch - 1], radius=9,
                                        fill=(255, 255, 255, 210))
photo.paste(pill, (pcx, pcy), pill)
# Draw "8 " and "ຮູບ" separately onto photo
pill_draw = ImageDraw.Draw(photo)
x_cur = pcx + 9
pill_draw.text((x_cur, pcy + 4), pc_lat, font=f_pc_lat, fill=(*INK, 200))
x_cur += tw(pc_lat, f_pc_lat)
pill_draw.text((x_cur, pcy + 4), pc_lao, font=f_pc_lao, fill=(*INK, 200))

# Coordinate text  (all-Latin, use SAN_R)
coord_font = f(SAN_R, 8)
pd.text((14, CH - 18), "17.9676° N  102.6275° E", font=coord_font,
        fill=(255, 255, 255, 85))

# Location text — pure Lao, double space as separator instead of ·
loc_font = f(LAO_R, 13)
pd.text((14, CH - 38), "ວຽງຈັນ  ສາຍລົມ", font=loc_font,
        fill=(255, 255, 255, 230))

# ── Info panel ─────────────────────────────────────────────────────────────────
info = Image.new("RGBA", (INFO_W, CH), (*WARM, 255))
ip   = ImageDraw.Draw(info)
PAD  = 22

# ─ Transaction badge "ຂາຍ"
tx_f   = f(LAO_R, 11)
tx_txt = "ຂາຍ"
txw    = tw(tx_txt, tx_f)
ip.rounded_rectangle([PAD, 18, PAD + txw + 18, 36], radius=9,
                     fill=(*TEAL, 16), outline=(*TEAL, 100), width=1)
ip.text((PAD + 9, 20), tx_txt, font=tx_f, fill=TEAL)

# ─ Property title:  "Villa " (SAN_B) + "ດ່ານຊ້ານ" (LAO_B)
vf  = f(SAN_B, 17)
tlf = f(LAO_B, 19)
vw  = tw("Villa ", vf)
ip.text((PAD,      44), "Villa ",   font=vf,  fill=INK)
ip.text((PAD + vw, 44), "ດ່ານຊ້ານ", font=tlf, fill=INK)

# ─ Subtitle — pure Lao only; use Lao word "ສອງ" for "2", no ASCII punctuation
ip.text((PAD, 71), "ເຮືອນ ສອງ ຊັ້ນ  ຍ່ານສາຍລົມ  ສວນ ແລະ ລານຈອດລົດ",
        font=f(LAO_R, 12), fill=MUTED)

# ─ Price  "$145,000" — SAN_B only (all Latin/digits)
ip.text((PAD, 92), "$145,000", font=f(SAN_B, 28), fill=INK)

# ─ Kip equivalent:  "1.17 " (SAN_R) + "ຕື້ ກີບ" (LAO_R)
kip_lat = "1.17 "
kip_lao = "ຕື້ ກີບ"
kf_lat = f(SAN_R, 11)
kf_lao = f(LAO_R, 11)
klw = tw(kip_lat, kf_lat)
ip.text((PAD,       127), kip_lat, font=kf_lat, fill=MUTED)
ip.text((PAD + klw, 127), kip_lao, font=kf_lao, fill=MUTED)

# ─ Spec grid
spec_y  = 150
sv_f    = f(SAN_B, 15)    # values:  pure Latin digits
sl_f_lo = f(LAO_R, 10)    # Lao labels
sl_f_la = f(SAN_R, 10)    # Latin labels (m²)
specs   = [("3", "ຫ້ອງ", False),
           ("2", "ຫ້ອງນ້ຳ", False),
           ("220", "m²", True),   # m² — needs SAN font
           ("2022", "ສ້າງ", False)]
item_w  = (INFO_W - PAD * 2) // 4
for i, (val, lbl, lbl_latin) in enumerate(specs):
    sx = PAD + i * item_w
    ip.text((sx, spec_y),      val, font=sv_f,                        fill=INK)
    ip.text((sx, spec_y + 20), lbl, font=sl_f_la if lbl_latin else sl_f_lo, fill=MUTED)
    if i < 3:
        sep_x = sx + item_w - 4
        ip.rectangle([sep_x, spec_y + 2, sep_x + 1, spec_y + 32], fill=(*WARMD, 200))

# ─ Divider
div_y = spec_y + 48
ip.rectangle([PAD, div_y, INFO_W - PAD, div_y + 1], fill=(*WARMD, 255))

# ─ Agent row
agent_y    = div_y + 12
agent_size = 38
agent_circ = circle_crop(Image.open("/home/user/pintag/agent-tik.jpg"), agent_size)
info.paste(agent_circ, (PAD, agent_y), agent_circ)

ip.text((PAD + agent_size + 10, agent_y + 2),  "Tik",            font=f(SAN_B, 13), fill=SOFT)
ip.text((PAD + agent_size + 10, agent_y + 18), "Property Agent", font=f(SAN_R, 10), fill=MUTED)

# PINTAG VERIFIED badge (right-aligned)
vb_f   = f(SAN_B, 8)
vb_txt = "PINTAG VERIFIED"
vbw    = tw(vb_txt, vb_f)
vbh    = th(vb_txt, vb_f)
vb_x   = INFO_W - PAD - vbw - 14
vb_y   = agent_y + 8
ip.rounded_rectangle([vb_x - 6, vb_y - 4, vb_x + vbw + 6, vb_y + vbh + 4],
                     radius=3, fill=(*TEAL, 14), outline=(*TEAL, 70), width=1)
ip.text((vb_x, vb_y), vb_txt, font=vb_f, fill=TEAL)

# ─ Contact buttons
btn_y = agent_y + agent_size + 14
wa_f   = f(SAN_B, 11)
wa_txt = "WhatsApp"
waw    = tw(wa_txt, wa_f)
ip.rounded_rectangle([PAD, btn_y, PAD + waw + 24, btn_y + 28],
                     radius=8, fill=(*TEAL_DK, 255))
ip.text((PAD + 12, btn_y + 7), wa_txt, font=wa_f, fill=WHITE)

call_lao = "ໂທ"
call_f   = f(LAO_R, 11)
callw    = tw(call_lao, call_f)
call_x   = PAD + waw + 36
ip.rounded_rectangle([call_x, btn_y, call_x + callw + 24, btn_y + 28],
                     radius=8, fill=(0, 0, 0, 0), outline=(*SOFT, 100), width=1)
ip.text((call_x + 12, btn_y + 7), call_lao, font=call_f, fill=SOFT)

# ── Assemble card ──────────────────────────────────────────────────────────────
card = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
card.paste(photo, (0, 0))
card.paste(info,  (PHOTO_W, 0))

card_mask = Image.new("L", (CW, CH), 0)
ImageDraw.Draw(card_mask).rounded_rectangle([0, 0, CW - 1, CH - 1], radius=CARD_R, fill=255)
rounded = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
rounded.paste(card, (0, 0), card_mask)

# Drop shadow
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(
    [CX - 8, CY + 8, CX + CW + 8, CY + CH + 12],
    radius=CARD_R + 6, fill=(0, 0, 0, 55))
shadow = shadow.filter(ImageFilter.GaussianBlur(20))
canvas = Image.alpha_composite(canvas, shadow)
canvas = paste_rgba(canvas, rounded, (CX, CY))

# ── Thumbnail rail (3 photos below card photo, height 52 px) ──────────────────
RAIL_H = 52
RAIL_Y = CY + CH + 2
RAIL_N = 3
gap    = 2
tw_    = (PHOTO_W - gap * (RAIL_N - 1)) // RAIL_N  # ~208 px

for i, path in enumerate([
    "/home/user/pintag/pintag-interior.png",
    "/home/user/pintag/pintag-exterior.png",
    "/home/user/pintag/pintag-balcony.png",
]):
    thumb = crop_fill(Image.open(path).convert("RGB"), tw_, RAIL_H).convert("RGBA")
    Image.alpha_composite(thumb, Image.new("RGBA", (tw_, RAIL_H), (0, 0, 0, 80)))
    tint = Image.new("RGBA", (tw_, RAIL_H), (0, 0, 0, 75))
    thumb = Image.alpha_composite(thumb, tint)
    canvas = paste_rgba(canvas, thumb, (CX + i * (tw_ + gap), RAIL_Y))

# Active indicator under first thumbnail
canvas = paste_rgba(canvas,
    Image.new("RGBA", (tw_, 2), (*TEAL, 255)),
    (CX, RAIL_Y + RAIL_H - 2))

# ── Headline ───────────────────────────────────────────────────────────────────
hl_f  = f(LAO_B, 62)
hl1   = "ຄົ້ນຫາ ແລະ ນຳສະເໜີ"
hl2   = "ຊັບສິນໃນລາວ"
hl1_w = tw(hl1, hl_f)
hl2_w = tw(hl2, hl_f)
hl1_h = th(hl1, hl_f)
hl2_h = th(hl2, hl_f)

HL_Y  = RAIL_Y + RAIL_H + 18
hl1_x = (W - hl1_w) // 2
hl2_x = (W - hl2_w) // 2

cd = ImageDraw.Draw(canvas)
cd.text((hl1_x, HL_Y),              hl1, font=hl_f, fill=WHITE)
cd.text((hl2_x, HL_Y + hl1_h + 6), hl2, font=hl_f, fill=TEAL_LT)

# ── pintag.io ──────────────────────────────────────────────────────────────────
url_f    = f(SAN_B, 15)
url_txt  = "pintag.io"
url_w    = tw(url_txt, url_f)
url_y    = HL_Y + hl1_h + 6 + hl2_h + 14
cd.text(((W - url_w) // 2, url_y), url_txt, font=url_f, fill=(*TEAL, 155))

# ── Save ───────────────────────────────────────────────────────────────────────
final = canvas.convert("RGB")
for path, fmt, kw in [
    ("/home/user/pintag/og-homepage.jpg", "JPEG",
     {"quality": 90, "optimize": True, "progressive": True}),
    ("/home/user/pintag/og-homepage.png", "PNG",
     {"optimize": True}),
]:
    final.save(path, fmt, **kw)
    print(f"{os.path.basename(path)}: {os.path.getsize(path) // 1024} KB")
