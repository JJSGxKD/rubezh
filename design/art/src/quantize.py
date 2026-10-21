"""Палитра 256 цветов с альфой для атласов существ и декора.

Плоский рисунок в два тона ложится в палитру без видимых потерь, а PNG
становится в 4–5 раз легче (design/art/characters.md, «Форматы и вес»).
Плитки земли сюда не идут: на их размытых пятнах палитра даёт ступеньки.

    python3 design/art/src/quantize.py design/art/out/atlas-core.png ...
"""

import sys

from PIL import Image


def quantize(path: str) -> None:
    image = Image.open(path).convert("RGBA")
    palette = image.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    palette.save(path, optimize=True)


if __name__ == "__main__":
    for target in sys.argv[1:]:
        quantize(target)
