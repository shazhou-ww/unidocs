#!/usr/bin/env python3
"""从全量 NotoSansSC-Regular.otf 生成本包内置的子集。

**这个脚本不在构建流程里。** 它是人工升级字体版本时跑一次的工具，产物（字节 +
src/fonts.generated.ts）提交进仓库。这样构建既不依赖 Python 也不依赖公网，
`pnpm deploy --prod` 直接把字节带进镜像。

用法（需要 fonttools）：
    python3 -m pip install fonttools brotli
    python3 scripts/build-subset.py ../../fonts/NotoSansSC-Regular.otf
然后跑 `node scripts/generate-index.mjs` 重新生成索引。

所有影响输出的参数都写死在下面，不接受命令行覆盖 —— 「重跑一次得到逐字节相同的
结果」这条性质，是靠没有可变参数保证的。
"""
import sys, pathlib
from fontTools import subset

HERE = pathlib.Path(__file__).resolve().parent
PKG = HERE.parent
OUT = PKG / "fonts" / "NotoSansSC-Regular.subset.otf"

# 汉字之外还要带的码位：ASCII 可打印、Latin-1 补充、通用标点、CJK 标点、全角形式。
# 少了这些，中文里的逗号句号引号会掉出子集，而掉出去的结果是不报错的空白字形。
BASE = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
        + list(range(0x2000, 0x2070)) + list(range(0x3000, 0x3040))
        + list(range(0xFF00, 0xFFF0)))

def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("用法: build-subset.py <全量 NotoSansSC-Regular.otf 的路径>")
    src = pathlib.Path(sys.argv[1]).resolve()
    chars = [c for c in (PKG / "charset" / "tongyong-guifan-8105.txt").read_text("utf-8").split()]
    if len(chars) != 8105:
        raise SystemExit(f"字表应有 8105 字，实际 {len(chars)}")
    unicodes = sorted(set(BASE) | {ord(c) for c in chars})
    subset.main([
        str(src),
        f"--output-file={OUT}",
        "--unicodes=" + ",".join(f"U+{c:04X}" for c in unicodes),
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
    ])
    print(f"{OUT.name}: {OUT.stat().st_size:,} bytes，覆盖 {len(unicodes)} 个码位")

if __name__ == "__main__":
    main()
