#!/usr/bin/env python3
"""Generate OG preview images for WhoPaid - matching site receipt aesthetic."""

from PIL import Image, ImageDraw, ImageFont
import os
import random

WIDTH = 1200
HEIGHT = 630

# Colors matching the site's CSS variables
PAPER = (250, 249, 246)           # --paper: #faf9f6
PAPER_SHADOW = (232, 230, 225)    # --paper-shadow: #e8e6e1
INK = (44, 44, 44)                # --ink: #2c2c2c
INK_LIGHT = (107, 107, 107)       # --ink-light: #6b6b6b
INK_FAINT = (160, 160, 160)       # --ink-faint: #a0a0a0
ACCENT = (212, 56, 13)            # --accent: #d4380d
BORDER = (217, 216, 212)          # --border: #d9d8d4
LINE_COLOR = (245, 244, 241)      # Subtle receipt lines


def load_typewriter_font(size):
    """Load a typewriter-style font (Courier family)."""
    typewriter_fonts = [
        "/System/Library/Fonts/Courier.ttc",
        "/Library/Fonts/Courier New.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for p in typewriter_fonts:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except:
                continue
    return ImageFont.load_default()


def load_typewriter_bold(size):
    """Load a bold typewriter-style font."""
    typewriter_fonts = [
        "/System/Library/Fonts/Courier.ttc",
        "/Library/Fonts/Courier New Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    ]
    for p in typewriter_fonts:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except:
                continue
    return ImageFont.load_default()


def load_body_font(size, bold=False):
    """Load a clean body font."""
    if bold:
        fonts = [
            "/System/Library/Fonts/SFNSDisplay.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    else:
        fonts = [
            "/System/Library/Fonts/SFNSDisplay.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    for p in fonts:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except:
                continue
    return ImageFont.load_default()


def draw_receipt_background(draw):
    """Draw receipt paper with faint horizontal lines."""
    draw.rectangle([(0, 0), (WIDTH, HEIGHT)], fill=PAPER)

    # Faint horizontal receipt lines
    line_spacing = 24
    for y in range(line_spacing, HEIGHT - 60, line_spacing):
        draw.line([(0, y), (WIDTH, y)], fill=LINE_COLOR, width=1)


def draw_dotted_line(draw, x1, y, x2, color=INK_FAINT, dot_spacing=8):
    """Draw a dotted/dashed separator line like the site uses."""
    x = x1
    while x < x2:
        draw.line([(x, y), (x + 3, y)], fill=color, width=1)
        x += dot_spacing


def draw_torn_edge(draw, y_start):
    """Draw the torn paper edge at bottom."""
    random.seed(42)

    # Softer perforation line
    perf_y = y_start
    x = 60
    while x < WIDTH - 60:
        # Small dots for perforation
        draw.ellipse([(x, perf_y - 1), (x + 2, perf_y + 1)], fill=(210, 208, 203))
        x += 12

    # Torn zigzag edge
    tear_y = y_start + 12
    points = [(0, tear_y)]
    x = 0
    while x < WIDTH:
        tooth_width = random.randint(18, 24)
        tooth_height = random.randint(6, 10)
        points.append((x, tear_y))
        points.append((x + tooth_width // 2, tear_y + tooth_height))
        x += tooth_width
    points.append((WIDTH, tear_y))
    points.append((WIDTH, HEIGHT))
    points.append((0, HEIGHT))

    draw.polygon(points, fill=(255, 255, 255))


def generate_generic_preview():
    """Generate the generic app preview OG image."""
    img = Image.new('RGB', (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(img)

    draw_receipt_background(draw)

    # Fonts - typewriter style to match site
    logo_font = load_typewriter_bold(32)
    label_font = load_typewriter_font(14)
    headline_font = load_typewriter_bold(56)
    subtext_font = load_body_font(18)
    meta_font = load_body_font(16)
    card_font = load_typewriter_font(18)
    card_amount_font = load_typewriter_bold(18)
    total_font = load_typewriter_bold(20)

    # === TOP BAR - Matching site header style ===
    top_y = 50

    # WhoPaid logo in typewriter style
    draw.text((60, top_y), "WhoPaid", fill=INK, font=logo_font)

    # Simple uppercase label (not a pill) matching site style
    label_text = "RECEIPT SPLITTER"
    label_bbox = draw.textbbox((0, 0), label_text, font=label_font)
    label_w = label_bbox[2] - label_bbox[0]
    draw.text((WIDTH - 60 - label_w, top_y + 10), label_text, fill=ACCENT, font=label_font)

    # === DOTTED DIVIDER ===
    draw_dotted_line(draw, 60, top_y + 55, WIDTH - 60)

    # === HEADLINE - Typewriter style, stacked ===
    headline_y = 130
    line_height = 58

    headlines = ["Scan receipts.", "Split items.", "Share totals."]
    for i, line in enumerate(headlines):
        draw.text((60, headline_y + i * line_height), line, fill=INK, font=headline_font)

    # Subtext
    subtext_y = headline_y + len(headlines) * line_height + 24
    draw.text((60, subtext_y), "Fast receipt splitting for groups.", fill=INK_LIGHT, font=subtext_font)

    # === DOTTED DIVIDER ===
    draw_dotted_line(draw, 60, subtext_y + 40, 500)

    # Metadata row
    meta_y = subtext_y + 60
    meta_text = "4 people · 12 items · £148.20 total"
    draw.text((60, meta_y), meta_text, fill=INK_FAINT, font=meta_font)

    # === RECEIPT FRAGMENT CARD (right side) ===
    card_x = 660
    card_y = 115
    card_w = 460
    card_padding = 28
    row_height = 44

    splits = [
        ("Alex", "£32.40"),
        ("Sam", "£41.10"),
        ("Priya", "£28.70"),
        ("You", "£46.00"),
    ]

    card_h = card_padding * 2 + len(splits) * row_height + 60

    # Light receipt-style border (less rounded)
    draw.rounded_rectangle(
        [(card_x, card_y), (card_x + card_w, card_y + card_h)],
        radius=8,
        fill=PAPER,
        outline=BORDER,
        width=1
    )

    # Split rows - receipt style
    item_y = card_y + card_padding
    for i, (name, amount) in enumerate(splits):
        # Name (left aligned)
        draw.text((card_x + card_padding, item_y), name, fill=INK, font=card_font)

        # Amount (right aligned) - dark gray
        amount_bbox = draw.textbbox((0, 0), amount, font=card_amount_font)
        amount_w = amount_bbox[2] - amount_bbox[0]
        draw.text(
            (card_x + card_w - card_padding - amount_w, item_y),
            amount,
            fill=INK,
            font=card_amount_font
        )

        item_y += row_height

    # Dotted divider above total
    total_div_y = item_y + 8
    draw_dotted_line(draw, card_x + card_padding, total_div_y, card_x + card_w - card_padding, BORDER)

    # Total row
    total_y = total_div_y + 16
    draw.text((card_x + card_padding, total_y), "Total", fill=INK_LIGHT, font=card_font)

    total_amount = "£148.20"
    total_bbox = draw.textbbox((0, 0), total_amount, font=total_font)
    total_w = total_bbox[2] - total_bbox[0]
    draw.text(
        (card_x + card_w - card_padding - total_w, total_y),
        total_amount,
        fill=ACCENT,
        font=total_font
    )

    # === TORN EDGE ===
    draw_torn_edge(draw, HEIGHT - 55)

    return img


def generate_shared_preview(store_name="Dinner at Lupa", date="Mar 14", people_count=4,
                            total="£148.20", splits=None):
    """Generate a shared receipt preview OG image."""
    img = Image.new('RGB', (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(img)

    draw_receipt_background(draw)

    # Fonts
    logo_font = load_typewriter_bold(26)
    label_font = load_typewriter_font(13)
    headline_font = load_typewriter_bold(50)
    meta_font = load_body_font(17)
    total_label_font = load_typewriter_font(14)
    total_font = load_typewriter_bold(48)
    card_font = load_typewriter_font(17)
    card_amount_font = load_typewriter_bold(17)

    # === TOP BAR ===
    top_y = 48

    draw.text((60, top_y), "WhoPaid", fill=INK_LIGHT, font=logo_font)

    label_text = "SHARED RECEIPT"
    label_bbox = draw.textbbox((0, 0), label_text, font=label_font)
    label_w = label_bbox[2] - label_bbox[0]
    draw.text((WIDTH - 60 - label_w, top_y + 6), label_text, fill=ACCENT, font=label_font)

    # === DOTTED DIVIDER ===
    draw_dotted_line(draw, 60, top_y + 48, WIDTH - 60)

    # === LEFT SIDE - Receipt summary ===
    left_x = 60

    # Store name in typewriter style
    draw.text((left_x, 125), store_name, fill=INK, font=headline_font)

    # Date and people
    meta_text = f"{date} · {people_count} people"
    draw.text((left_x, 188), meta_text, fill=INK_LIGHT, font=meta_font)

    # Dotted divider
    draw_dotted_line(draw, left_x, 230, 400)

    # Total section
    draw.text((left_x, 260), "TOTAL", fill=INK_FAINT, font=total_label_font)
    draw.text((left_x, 285), total, fill=ACCENT, font=total_font)

    # === RIGHT SIDE - Split card ===
    if splits is None:
        splits = [
            ("Alex", "£32.40"),
            ("Sam", "£41.10"),
            ("Priya", "£28.70"),
            ("Jordan", "£46.00"),
        ]

    card_x = 560
    card_y = 110
    card_w = 560
    card_padding = 26
    row_height = 46

    card_h = card_padding * 2 + min(len(splits), 5) * row_height

    draw.rounded_rectangle(
        [(card_x, card_y), (card_x + card_w, card_y + card_h)],
        radius=8,
        fill=PAPER,
        outline=BORDER,
        width=1
    )

    item_y = card_y + card_padding
    for i, (name, amount) in enumerate(splits[:5]):
        draw.text((card_x + card_padding, item_y), name, fill=INK, font=card_font)

        amount_bbox = draw.textbbox((0, 0), amount, font=card_amount_font)
        amount_w = amount_bbox[2] - amount_bbox[0]
        draw.text(
            (card_x + card_w - card_padding - amount_w, item_y),
            amount,
            fill=INK,
            font=card_amount_font
        )

        # Dotted divider between rows
        if i < min(len(splits), 5) - 1:
            div_y = item_y + row_height - 10
            draw_dotted_line(draw, card_x + card_padding, div_y, card_x + card_w - card_padding, (235, 233, 228))

        item_y += row_height

    if len(splits) > 5:
        more_text = f"+{len(splits) - 5} more"
        draw.text((card_x + card_padding, item_y), more_text, fill=INK_FAINT, font=card_font)

    # === TORN EDGE ===
    draw_torn_edge(draw, HEIGHT - 50)

    return img


if __name__ == "__main__":
    output_dir = os.path.dirname(os.path.abspath(__file__))

    # Generate generic preview
    generic_img = generate_generic_preview()
    generic_path = os.path.join(output_dir, "og-image.png")
    generic_img.save(generic_path, "PNG", optimize=True)
    print(f"Generated {generic_path} ({WIDTH}x{HEIGHT})")

    # Generate example shared preview
    shared_img = generate_shared_preview()
    shared_path = os.path.join(output_dir, "og-image-shared-example.png")
    shared_img.save(shared_path, "PNG", optimize=True)
    print(f"Generated {shared_path} ({WIDTH}x{HEIGHT})")
