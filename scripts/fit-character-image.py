#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把任意图片转成无名杀立绘规格,直接落到 apps/core/image/character/<id>.jpg

用法:
    python scripts/fit-character-image.py <输入图> <武将id>
    python scripts/fit-character-image.py ~/Downloads/张臶.webp zhangjian

规格(见 docs/CHARACTER-IMAGES.md):350x464 JPEG,宽高比 0.754。
裁切语义对齐游戏的显示方式(polyfill.ts:background-size cover + backgroundPositionX center,
不设 positionY 故顶部对齐)—— 所以这里也是【横向居中、纵向偏上】,裁脚不裁头。

依赖:pip install Pillow
"""

import sys
import os

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow: pip install Pillow")

W, H = 350, 464
TOP_BIAS = 0.15  # 纵向裁切位置:0=顶部对齐, 0.5=居中。0.15 略偏上,保住头顶又不至于贴边

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "core", "image", "character")


def fit(src_path, char_id):
    im = Image.open(src_path)

    # 带透明通道的(webp/png 常见)先合成到白底,否则转 JPEG 时透明区会变黑
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")

    ow, oh = im.size
    scale = max(W / ow, H / oh)  # cover:短边填满,长边溢出后裁掉
    nw, nh = round(ow * scale), round(oh * scale)
    im = im.resize((nw, nh), Image.LANCZOS)

    left = (nw - W) // 2               # 横向居中
    top = int((nh - H) * TOP_BIAS)     # 纵向偏上
    im = im.crop((left, top, left + W, top + H))

    out = os.path.normpath(os.path.join(OUT_DIR, char_id + ".jpg"))
    im.save(out, "JPEG", quality=90, optimize=True, progressive=False)

    kb = os.path.getsize(out) // 1024
    print("OK %s -> %s  (%dx%d, %dKB)" % (os.path.basename(src_path).encode("ascii", "replace").decode(), out, W, H, kb))
    if kb > 250:
        print("   注意:超过 250KB 建议值,可降 quality")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    fit(sys.argv[1], sys.argv[2])
