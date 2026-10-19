"""命令行入口：兑换码 CSV + 文案清单 → RGB/CMYK 两套 A4 横向双面 6-up 拼版 PDF。

用法示例：
  python tools/voucher/generate/make_vouchers.py --csv tools/voucher/mock/codes_mock.csv \
      --quotes tools/voucher/mock/quotes.mock.txt --out tools/voucher/out
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import layout as layout_mod  # noqa: E402
import vouchers  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="生成 ModelGate 实体兑换券拼版 PDF（RGB 与 CMYK 两套，A4 横向双面 6-up）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--csv", required=True, help="兑换码 CSV，两列：兑换码,批次（首行可为表头）")
    parser.add_argument("--quotes", default=str(vouchers.DEFAULT_QUOTES), help="文案清单（纯文本，一行一条）")
    parser.add_argument("--assets", default=str(vouchers.DEFAULT_ASSETS), help="底图目录（front/back × rgb/cmyk）")
    parser.add_argument("--out", default=str(vouchers.DEFAULT_OUT), help="输出目录")
    parser.add_argument("--basename", default="vouchers", help="输出文件名前缀")
    parser.add_argument("--sets", default="rgb,cmyk", help="输出哪几套：rgb、cmyk 或两者逗号分隔")
    parser.add_argument("--sheets", type=int, default=None, help="只排前 N 张纸（调试用，默认全部）")
    parser.add_argument("--flip", default="h", choices=("h", "v"), help="双面翻转方向：h 左右、v 上下")
    parser.add_argument("--font", default=None, help="中文文案字体（TTF/TTC）")
    parser.add_argument("--mono-font", dest="mono_font", default=None, help="兑换码与序列号等宽字体")
    parser.add_argument("--icc", default=None, help="JapanColor2001Coated ICC 路径")
    parser.add_argument("--layout", default=None, help="版式覆盖 JSON（区域矩形与二维码框）")
    parser.add_argument("--on-overflow", dest="on_overflow", default="error", choices=("error", "warn"),
                        help="文案超宽时：error 停止并报行号，warn 缩小字号后继续")
    parser.add_argument("--zlib-level", dest="zlib_level", type=int, default=6, help="图像压缩级别 1-9")
    parser.add_argument("--check-quotes", dest="check_quotes", action="store_true", help="只体检文案宽度，不出 PDF")
    parser.add_argument("--no-manifest", dest="manifest", action="store_false", help="不写清单 JSON")
    parser.add_argument("--front-rgb", default=None)
    parser.add_argument("--back-rgb", default=None)
    parser.add_argument("--front-cmyk", default=None)
    parser.add_argument("--back-cmyk", default=None)
    parser.add_argument("--quiet", action="store_true", help="少打印过程信息")
    return parser


def main(argv: "list[str] | None" = None) -> int:
    args = build_parser().parse_args(argv)
    log = (lambda *a, **k: None) if args.quiet else print
    layout = layout_mod.load_layout(args.layout)
    config = vouchers.GenerateConfig(
        csv_path=Path(args.csv),
        quotes_path=Path(args.quotes),
        assets_dir=Path(args.assets),
        out_dir=Path(args.out),
        basename=args.basename,
        sets=tuple(part.strip() for part in args.sets.split(",") if part.strip()),
        sheets=args.sheets,
        flip=args.flip,
        font_path=args.font,
        mono_path=args.mono_font,
        icc_path=args.icc,
        layout=layout,
        on_overflow=args.on_overflow,
        zlib_level=args.zlib_level,
        front_rgb=Path(args.front_rgb) if args.front_rgb else None,
        back_rgb=Path(args.back_rgb) if args.back_rgb else None,
        front_cmyk=Path(args.front_cmyk) if args.front_cmyk else None,
        back_cmyk=Path(args.back_cmyk) if args.back_cmyk else None,
        write_manifest=args.manifest,
        log=log,
    )
    try:
        if args.check_quotes:
            quotes = vouchers.load_quotes(config.quotes_path)
            label, path = vouchers.discover_font(config.font_path)
            overflows = vouchers.validate_quotes(quotes, path, layout)
            print(f"文案清单：{config.quotes_path}（{len(quotes)} 条，字体 {label} {path}）")
            for item in overflows:
                print("  " + item.message())
            width_mm = layout_mod.px_to_mm(layout.back_quote_text.width)
            height_mm = layout_mod.px_to_mm(layout.back_quote_text.height)
            if overflows:
                print(f"结论：{len(overflows)} 条超出可用宽度，需要修改清单")
                return 2
            print(f"结论：全部文案在 {width_mm:.1f}mm 宽 × {height_mm:.1f}mm 高（字高 {layout.quote_em_mm}mm）的可用区内")
            return 0
        report = vouchers.generate(config)
    except vouchers.VoucherError as error:
        print(f"生成失败：{error}", file=sys.stderr)
        return 2
    print("")
    print(f"兑换码：{report.codes} 行（本次使用 {report.codes} 张券）")
    print(f"序列号：0001-{report.codes:04d}，唯一 {report.codes} 张")
    print(f"文案：{report.quotes} 条，字体 {report.font_label}（{report.font_path}）")
    distinct = min(report.quotes, layout_mod.SHEET_COUPONS)
    print(f"每面文案去重：每张纸使用 {distinct} 条不同文案" + ("（文案不足 6 条，已按最大值铺开）" if distinct < layout_mod.SHEET_COUPONS else ""))
    print("文案使用次数（按清单行号）：")
    usage_by_line = report.manifest.get("quote_usage", {})
    for lineno, count in usage_by_line.items():
        print(f"  第 {lineno:>3} 行 × {count} 次")
    print(f"排版：{report.sheets} 张纸 × 2 面 = {report.sheets * 2} 页")
    for result in report.sets:
        print(f"{result.name.upper():>4}：{result.pdf_path}  {result.bytes_written / 1048576:.1f} MB  {result.pages} 页  "
              f"唯一图像 {result.unique_images}" + ("  OutputIntent=JapanColor2001Coated" if result.output_intent else ""))
    if report.manifest_path:
        print(f"清单：{report.manifest_path}")
    for warning in report.warnings:
        print(f"告警：{warning}")
    print(f"耗时：{report.elapsed_s:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
