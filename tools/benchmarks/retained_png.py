# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.0.0"]
# ///
"""Rasterize captured styled terminal cells and decoded Kitty placements, without inventing UI."""
import base64
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

root = Path(sys.argv[1])
cw, ch = 10, 22
font_root = Path("/usr/share/fonts/truetype/dejavu")
symbol_font = Path(__file__).resolve().parents[2] / "dist/retained-fonts/NotoSansSymbols2-Regular.ttf"
math_font = symbol_font.with_name("NotoSansMath-Regular.ttf")
fonts = {}
for bold in [False, True]:
    for italic in [False, True]:
        suffix = "-BoldOblique" if bold and italic else "-Bold" if bold else "-Oblique" if italic else ""
        fonts[bold, italic] = [ImageFont.truetype(str(font_root / (name + suffix + ".ttf")), 17)
                               for name in ["DejaVuSansMono", "DejaVuSans"]]
        fonts[bold, italic].append(ImageFont.truetype(str(font_root / "DejaVuMathTeXGyre.ttf"), 17))
        if symbol_font.exists():
            fonts[bold, italic].append(ImageFont.truetype(str(symbol_font), 17))
        if math_font.exists():
            fonts[bold, italic].append(ImageFont.truetype(str(math_font), 17))
missing = set()
chosen_fonts = {}


def render(frame):
    image = Image.new("RGB", (frame["cols"] * cw, frame["rows"] * ch), (24, 27, 32))
    draw = ImageDraw.Draw(image)
    for y, row in enumerate(frame["cells"]):
        for cell in row:
            x, width = cell["x"] * cw, cell["width"] * cw
            draw.rectangle((x, y * ch, x + max(1, width) - 1, (y + 1) * ch - 1), fill=tuple(cell["bg"]))
        for cell in row:
            x, width = cell["x"] * cw, cell["width"] * cw
            glyph = cell["text"]
            key = (glyph, cell["bold"], cell["italic"])
            if key not in chosen_fonts:
                choices = fonts[cell["bold"], cell["italic"]]
                font = next((f for f in choices if bytes(f.getmask(glyph)) != bytes(f.getmask("\U0010ffff"))), choices[0])
                if bytes(font.getmask(glyph)) == bytes(font.getmask("\U0010ffff")):
                    missing.add(glyph)
                chosen_fonts[key] = font
            font = chosen_fonts[key]
            fg = tuple(round((a + b) / 2) for a, b in zip(cell["fg"], cell["bg"])) if cell["faint"] else tuple(cell["fg"])
            draw.text((x, y * ch + 17), glyph, font=font, anchor="ls", fill=fg)
            if cell["underline"]:
                draw.line((x, y * ch + 19, x + width - 1, y * ch + 19), fill=fg)
            if cell["strike"]:
                draw.line((x, y * ch + 11, x + width - 1, y * ch + 11), fill=fg)
    for placement in sorted(frame["images"], key=lambda item: item["z"]):
        meta = placement["image"]
        mode = {24: "RGB", 32: "RGBA"}[meta["format"]]
        pixels = Image.frombytes(mode, (meta["width"], meta["height"]), base64.b64decode(placement["data"]))
        sx, sy = placement["source_x"], placement["source_y"]
        tile = pixels.crop((sx, sy, sx + placement["source_width"], sy + placement["source_height"]))
        tile = tile.resize((max(1, round(placement["width"] * cw)), max(1, round(placement["height"] * ch))), Image.Resampling.LANCZOS)
        image.paste(tile, (round(placement["x"] * cw), round(placement["y"] * ch)), tile if mode == "RGBA" else None)
    if frame["cursor"]:
        x, y = frame["cursor"]["x"] * cw, frame["cursor"]["y"] * ch
        draw.rectangle((x, y, x + cw - 1, y + ch - 1), outline=(238, 241, 244))
    return image


names = []
for role in ["baseline", "candidate"]:
    for path in sorted((root / role).glob("[0-9]*.json")):
        frame = json.loads(path.read_text())
        render(frame).save(path.with_suffix(".png"))
        if role == "baseline":
            names.append(path.stem)
comparisons = []
for name in names:
    left, right = [Image.open(root / role / f"{name}.png").convert("RGB") for role in ["baseline", "candidate"]]
    sheet = Image.new("RGB", (left.width + right.width, max(left.height, right.height) + 30), (24, 27, 32))
    draw = ImageDraw.Draw(sheet)
    draw.text((10, 5), f"BASELINE — {name}", font=fonts[False, False][0], fill=(209, 214, 219))
    draw.text((left.width + 10, 5), f"CANDIDATE — {name}", font=fonts[False, False][0], fill=(209, 214, 219))
    sheet.paste(left, (0, 30)); sheet.paste(right, (left.width, 30))
    sheet.save(root / f"{name}-comparison.png")
    paths = [root / role / f"{name}.png" for role in ["baseline", "candidate"]]
    hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    comparisons.append({"name": name, "same": hashes[0] == hashes[1], "baseline_sha256": hashes[0], "candidate_sha256": hashes[1]})
    if hashes[0] != hashes[1] and left.size == right.size:
        ImageChops.difference(left, right).save(root / f"{name}-difference.png")
(root / "png-comparison.json").write_text(json.dumps(comparisons, indent=2) + "\n")
(root / "rasterizer.json").write_text(json.dumps({"cell_pixels": [cw, ch], "font": str(font_root),
                                                  "symbol_font": str(symbol_font) if symbol_font.exists() else None,
                                                  "math_font": str(math_font) if math_font.exists() else None,
                                                  "missing_glyphs": sorted(missing)}, indent=2) + "\n")
print(f"Rendered {len(names)} baseline/candidate PNG pairs; missing glyphs: {sorted(missing)!r}")
