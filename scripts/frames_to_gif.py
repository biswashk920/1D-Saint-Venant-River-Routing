"""Assemble captured frames into a compact GIF.   python scripts/frames_to_gif.py <frames_dir> <out.gif>"""
import sys
from pathlib import Path

from PIL import Image

frames_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
files = sorted(frames_dir.glob("f*.png"))
imgs = []
for f in files:
    im = Image.open(f).convert("RGB")
    im = im.resize((720, round(720 * im.height / im.width)), Image.LANCZOS)
    imgs.append(im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=90, loop=0, optimize=True)
print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(imgs)} frames)")
