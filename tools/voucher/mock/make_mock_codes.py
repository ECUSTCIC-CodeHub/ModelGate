"""生成 600 行 mock 兑换码 CSV（确定性，可重复生成）。"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
COUNT = 600


def make_codes(count: int = COUNT, seed: int = 20261018) -> list[str]:
    rng = random.Random(seed)
    seen: set[str] = set()
    codes: list[str] = []
    while len(codes) < count:
        raw = "".join(rng.choice(ALPHABET) for _ in range(12))
        code = f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"
        if code in seen:
            continue
        seen.add(code)
        codes.append(code)
    return codes


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="生成 mock 兑换码 CSV")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "codes_mock.csv"))
    parser.add_argument("--count", type=int, default=COUNT)
    parser.add_argument("--batch", default="MOCK-20261018")
    args = parser.parse_args(argv)
    codes = make_codes(args.count)
    lines = ["兑换码,批次"] + [f"{code},{args.batch}" for code in codes]
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已写入 {path}：{len(codes)} 行（含表头）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
