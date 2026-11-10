"""Render demo/transcript.json (real agentkeep output) as a terminal GIF.

    node demo/capture.mjs && python demo/render.py

Commands are "typed" a few characters per frame; command output appears at
once, as it does in a real terminal. Needs Pillow and the Cascadia Mono and
Segoe UI Symbol fonts (Windows); set AGENTKEEP_FONT / AGENTKEEP_SYMBOL_FONT to
use others.
"""
import json
import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
FONT = os.environ.get("AGENTKEEP_FONT", "C:/Windows/Fonts/CascadiaMono.ttf")
SYMBOL = os.environ.get("AGENTKEEP_SYMBOL_FONT", "C:/Windows/Fonts/seguisym.ttf")
SIZE = 15
COLS, ROWS = 76, 22
PAD_X, PAD_TOP, PAD_BOTTOM = 18, 44, 16

BG = (24, 26, 33)
BAR = (36, 39, 48)
FG = (214, 218, 226)
DIM = (120, 127, 142)
COLORS = {"31": (240, 98, 98), "32": (110, 210, 140), "33": (230, 190, 90)}
PROMPT = (110, 170, 255)
NOTE = (150, 156, 170)

font = ImageFont.truetype(FONT, SIZE)
bold = ImageFont.truetype(FONT.replace("Mono.ttf", "Mono.ttf"), SIZE)
symbol = ImageFont.truetype(SYMBOL, SIZE - 1)
mark_font = ImageFont.truetype(SYMBOL, SIZE + 1)
MARKS = "✓✗↺"
CW = round(font.getlength("M"))
LH = round(SIZE * 1.5)
W = PAD_X * 2 + CW * COLS
H = PAD_TOP + LH * ROWS + PAD_BOTTOM
def _mask_bytes(ch):
    m = font.getmask(ch)
    return m.size, bytes(m)


TOFU = _mask_bytes("\uffff")


def has_glyph(ch):
    # ASCII is always in the mono font. For anything else, compare the
    # rendered pixels with the missing-glyph box (comparing only bounding
    # boxes mistakes letters like "S" for it).
    return ord(ch) < 128 or _mask_bytes(ch) != TOFU


def parse_ansi(line):
    """Split a line into (text, color, bold) runs."""
    runs, color, is_bold = [], FG, False
    for part in re.split(r"(\x1b\[[0-9;]*m)", line):
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", part)
        if not m:
            if part:
                runs.append((part, color, is_bold))
            continue
        for code in (m.group(1) or "0").split(";"):
            if code == "0":
                color, is_bold = FG, False
            elif code == "1":
                is_bold = True
            elif code == "2":
                color = DIM
            elif code in COLORS:
                color = COLORS[code]
    return runs


def draw_line(d, row, runs):
    x, y = PAD_X, PAD_TOP + row * LH
    for text, color, is_bold in runs:
        for ch in text:
            if ch in MARKS:
                # Status marks: symbol font, drawn twice so they read as bold.
                w = mark_font.getlength(ch)
                for dx in (0, 1):
                    d.text((x + (CW - w) / 2 + dx, y), ch, font=mark_font, fill=color)
            elif has_glyph(ch):
                d.text((x, y), ch, font=font, fill=color)
                if is_bold:
                    d.text((x + 1, y), ch, font=font, fill=color)
            else:
                # Symbols missing from the mono font, centred in one cell.
                w = symbol.getlength(ch)
                d.text((x + (CW - w) / 2, y + 1), ch, font=symbol, fill=color)
            x += CW


def frame(lines, cursor=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 30], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([14 + i * 20, 10, 26 + i * 20, 22], fill=c)
    title = "~ — agentkeep"
    d.text(((W - font.getlength(title)) / 2, 7), title, font=font, fill=DIM)
    for row, runs in enumerate(lines[-ROWS:]):
        draw_line(d, row, runs)
    if cursor is not None:
        row = min(len(lines), ROWS) - 1
        x = PAD_X + cursor * CW
        y = PAD_TOP + row * LH
        d.rectangle([x, y + 2, x + CW - 2, y + LH - 4], fill=FG)
    return img


def main():
    steps = json.loads((HERE / "transcript.json").read_text(encoding="utf-8"))
    frames, durations = [], []
    lines = []

    def add(img, ms):
        frames.append(img)
        durations.append(ms)

    for i, step in enumerate(steps):
        if step["cmd"] is None:
            if lines:
                lines.append([])
            lines.append([(step["note"], NOTE, False)])
            add(frame(lines), 1600)
            continue
        if i and step["cmd"] == "npx agentkeep check" and steps[i - 1]["cmd"] == "npx agentkeep restore":
            pass
        if lines:
            lines.append([])
        prompt = [("$ ", PROMPT, True)]
        lines.append(prompt)
        add(frame(lines, cursor=2), 500)
        cmd = step["cmd"]
        for n in range(2, len(cmd) + 1, 2):
            lines[-1] = prompt + [(cmd[:n], FG, False)]
            add(frame(lines, cursor=2 + n), 45)
        lines[-1] = prompt + [(cmd, FG, False)]
        add(frame(lines, cursor=2 + len(cmd)), 450)
        lines.append([])
        lines.pop()
        for out in step["out"]:
            lines.append(parse_ansi(out))
        hold = 3800 if "check" in cmd else 2600
        add(frame(lines), hold)
    durations[-1] = 4000

    # A small shared palette keeps the file small and colours exact.
    pal = frames[-3].quantize(colors=64, method=Image.Quantize.MEDIANCUT)
    out = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    path = HERE / "demo.gif"
    out[0].save(path, save_all=True, append_images=out[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{path}  {W}x{H}  {len(frames)} frames  {sum(durations) / 1000:.1f}s  {path.stat().st_size // 1024} KB")
    frame(lines).save(HERE / "last-frame.png")


if __name__ == "__main__":
    main()
