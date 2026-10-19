"""把拼版 PDF 的某一页还原成 PNG，用于肉眼核对版式（不参与印刷交付）。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pdfread  # noqa: E402

PT_TO_INCH = 72.0


def render_page(document: pdfread.PdfDocument, index: int, dpi: int) -> Image.Image:
    page = document.pages[index]
    width_pt = page.media_box[2] - page.media_box[0]
    height_pt = page.media_box[3] - page.media_box[1]
    scale = dpi / PT_TO_INCH
    canvas = Image.new("RGB", (round(width_pt * scale), round(height_pt * scale)), (255, 255, 255))
    for name, x_pt, y_pt, w_pt, h_pt in page.operations:
        object_id = page.xobjects[name]
        source = document.images[object_id]
        target_w = max(1, round(w_pt * scale))
        target_h = max(1, round(h_pt * scale))
        resized = source.convert("RGB").resize((target_w, target_h), Image.NEAREST)
        canvas.paste(resized, (round(x_pt * scale), round((height_pt - y_pt - h_pt) * scale)))
    return canvas


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="PDF 页面预览")
    parser.add_argument("pdf")
    parser.add_argument("--page", type=int, default=1, help="页码，从 1 开始")
    parser.add_argument("--out", default=None)
    parser.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args(argv)
    document = pdfread.PdfDocument(Path(args.pdf))
    canvas = render_page(document, args.page - 1, args.dpi)
    out = Path(args.out) if args.out else Path(args.pdf).with_name(f"{Path(args.pdf).stem}_page{args.page}.png")
    canvas.save(out)
    print(f"已渲染第 {args.page} 页 → {out}（{canvas.size[0]}×{canvas.size[1]}px，{args.dpi} dpi）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
