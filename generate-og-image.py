#!/usr/bin/env python3
"""Generate the OG preview image for WhoPaid."""

from PIL import Image, ImageDraw, ImageFont
import os

WIDTH = 1200
HEIGHT = 630

# Colors
PAPER = (250, 249, 246)       # #faf9f6
PAPER_LINE = (232, 230, 225)  # #e8e6e1
INK = (51, 51, 51)            # #333333
ACCENT = (212, 56, 13)        # #d4380d
CORNER_COLOR = (80, 80, 80)   # Dark gray for scan corners

img = Image.new('RGB', (WIDTH, HEIGHT), PAPER)
draw = ImageDraw.Draw(img)

# --- Receipt paper lines (horizontal ruled lines) ---
line_spacing = 28
for y in range(60, HEIGHT - 60, line_spacing):
    draw.line([(60, y), (WIDTH - 60, y)], fill=PAPER_LINE, width=1)

# --- Thicker border (outer receipt edge) ---
border_width = 3
border_color = (200, 198, 193)  # Subtle gray border
for i in range(border_width):
    draw.rectangle(
        [(40 + i, 30 + i), (WIDTH - 40 - i, HEIGHT - 70 - i)],
        outline=border_color
    )

# --- Corner scan marks (L-shaped brackets, thick and obvious) ---
corner_len = 60
corner_w = 5
margin_x = 30
margin_y = 20

# Top-left
draw.rectangle([(margin_x, margin_y), (margin_x + corner_len, margin_y + corner_w)], fill=CORNER_COLOR)
draw.rectangle([(margin_x, margin_y), (margin_x + corner_w, margin_y + corner_len)], fill=CORNER_COLOR)

# Top-right
draw.rectangle([(WIDTH - margin_x - corner_len, margin_y), (WIDTH - margin_x, margin_y + corner_w)], fill=CORNER_COLOR)
draw.rectangle([(WIDTH - margin_x - corner_w, margin_y), (WIDTH - margin_x, margin_y + corner_len)], fill=CORNER_COLOR)

# Bottom-left
draw.rectangle([(margin_x, HEIGHT - 70 - corner_w), (margin_x + corner_len, HEIGHT - 70)], fill=CORNER_COLOR)
draw.rectangle([(margin_x, HEIGHT - 70 - corner_len), (margin_x + corner_w, HEIGHT - 70)], fill=CORNER_COLOR)

# Bottom-right
draw.rectangle([(WIDTH - margin_x - corner_len, HEIGHT - 70 - corner_w), (WIDTH - margin_x, HEIGHT - 70)], fill=CORNER_COLOR)
draw.rectangle([(WIDTH - margin_x - corner_w, HEIGHT - 70 - corner_len), (WIDTH - margin_x, HEIGHT - 70)], fill=CORNER_COLOR)

# --- Torn paper edge at bottom ---
tear_y = HEIGHT - 60
tear_height = 20
tooth_width = 16
x = 40
while x < WIDTH - 40:
    x1 = x
    x2 = min(x + tooth_width, WIDTH - 40)
    mid = (x1 + x2) // 2
    # Draw triangle tooth
    draw.polygon([(x1, tear_y), (mid, tear_y + tear_height), (x2, tear_y)], fill=PAPER)
    # Draw the tooth outline
    draw.line([(x1, tear_y), (mid, tear_y + tear_height)], fill=border_color, width=2)
    draw.line([(mid, tear_y + tear_height), (x2, tear_y)], fill=border_color, width=2)
    x += tooth_width

# Fill below torn edge with white (background)
draw.rectangle([(0, tear_y + tear_height), (WIDTH, HEIGHT)], fill=(255, 255, 255))

# --- Try to load fonts, fall back to default ---
def load_font(name, size):
    paths = [
        f"/usr/share/fonts/truetype/{name}",
        f"/usr/share/fonts/{name}",
        f"/usr/local/share/fonts/{name}",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    # Try system default
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except:
        return ImageFont.load_default()

def load_mono_font(size):
    mono_fonts = [
        "dejavu/DejaVuSansMono.ttf",
        "liberation/LiberationMono-Regular.ttf",
        "truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for name in mono_fonts:
        paths = [
            f"/usr/share/fonts/truetype/{name}",
            f"/usr/share/fonts/{name}",
        ]
        for p in paths:
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    try:
        return ImageFont.truetype("DejaVuSansMono.ttf", size)
    except:
        return ImageFont.load_default()

# Load fonts
title_font = load_font("dejavu/DejaVuSans-Bold.ttf", 72)
mono_font = load_mono_font(28)
mono_font_sm = load_mono_font(22)
accent_font = load_mono_font(26)

# --- Title: ✦  WhoPaid  ✦ ---
title_text = "WhoPaid"
bbox = draw.textbbox((0, 0), title_text, font=title_font)
tw = bbox[2] - bbox[0]
title_x = (WIDTH - tw) // 2
title_y = 110

draw.text((title_x, title_y), title_text, fill=INK, font=title_font)

# Draw diamond stars on either side
star = "✦"
star_font = load_font("dejavu/DejaVuSans.ttf", 36)
draw.text((title_x - 70, title_y + 20), star, fill=INK, font=star_font)
draw.text((title_x + tw + 35, title_y + 20), star, fill=INK, font=star_font)

# --- Dashed divider ---
divider_y = 220
dash_text = "- " * 30
bbox = draw.textbbox((0, 0), dash_text, font=mono_font)
dw = bbox[2] - bbox[0]
draw.text(((WIDTH - dw) // 2, divider_y), dash_text, fill=(180, 178, 173), font=mono_font)

# --- Tagline ---
tagline = "Split it. Send it. Sorted."
bbox = draw.textbbox((0, 0), tagline, font=mono_font)
tgw = bbox[2] - bbox[0]
draw.text(((WIDTH - tgw) // 2, 275), tagline, fill=(120, 118, 113), font=mono_font)

# --- Equals divider ---
eq_y = 330
eq_text = "= " * 25
bbox = draw.textbbox((0, 0), eq_text, font=mono_font_sm)
eqw = bbox[2] - bbox[0]
draw.text(((WIDTH - eqw) // 2, eq_y), eq_text, fill=(200, 198, 193), font=mono_font_sm)

# --- SCAN · SPLIT · SHARE ---
cta = "SCAN  ·  SPLIT  ·  SHARE"
bbox = draw.textbbox((0, 0), cta, font=accent_font)
ctaw = bbox[2] - bbox[0]
draw.text(((WIDTH - ctaw) // 2, 385), cta, fill=ACCENT, font=accent_font)

# --- Save ---
output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "og-image.png")
img.save(output_path, "PNG", optimize=True)
print(f"Generated {output_path} ({WIDTH}x{HEIGHT})")
