"""Проверка арта на цветовую слепоту (design/art/meta-v2.md §9, «Доступность»).

Кадр — четыре раза рядом: как видит обычный глаз, при дейтеранопии,
протанопии и тританопии. Матрицы — Machado, Oliveira, Fernandes (2009),
полная сила, в линейном RGB. Нужен, когда в игру приходит новый цвет
угрозы, подбора или стихии: различимо ли без цвета, видно сразу.

    python3 design/art/src/cvd.py кадр.png [кадр2.png …] -o полоса.png
"""

import argparse

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MATRICES = {
    "норма": np.eye(3),
    "дейтеранопия": np.array([[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]),
    "протанопия": np.array([[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]),
    "тританопия": np.array([[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]),
}


def to_linear(srgb: np.ndarray) -> np.ndarray:
    value = srgb / 255.0
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def to_srgb(linear: np.ndarray) -> np.ndarray:
    value = np.clip(linear, 0, 1)
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * value ** (1 / 2.4) - 0.055) * 255


def simulate(image: Image.Image, matrix: np.ndarray) -> Image.Image:
    linear = to_linear(np.asarray(image.convert("RGB")).astype(np.float64))
    return Image.fromarray(to_srgb(linear @ matrix.T).astype(np.uint8))


def label_font() -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    """Шрифт подписей с кириллицей: встроенный в Pillow её не знает. Linux, затем Windows."""
    for name in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, 15)
        except OSError:
            continue
    return ImageFont.load_default()


def strip(frames: list[Image.Image]) -> Image.Image:
    width, height = frames[0].size
    out = Image.new("RGB", (width * len(MATRICES), (height + 28) * len(frames)), (15, 14, 26))
    draw = ImageDraw.Draw(out)
    font = label_font()
    for row, frame in enumerate(frames):
        top = row * (height + 28)
        for col, (name, matrix) in enumerate(MATRICES.items()):
            draw.text((col * width + 8, top + 6), name, fill=(243, 238, 230), font=font)
            out.paste(simulate(frame.resize((width, height)), matrix), (col * width, top + 28))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("frames", nargs="+")
    parser.add_argument("-o", "--out", required=True)
    parser.add_argument("--width", type=int, default=390, help="ширина одного кадра в полосе")
    args = parser.parse_args()
    first = Image.open(args.frames[0])
    height = round(first.height * args.width / first.width)
    frames = [Image.open(path).resize((args.width, height)) for path in args.frames]
    strip(frames).save(args.out, optimize=True)


if __name__ == "__main__":
    main()
