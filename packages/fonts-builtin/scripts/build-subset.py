#!/usr/bin/env python3
"""从全量 NotoSansSC-Regular.otf 生成本包内置的子集。

**这个脚本不在构建流程里。** 它是人工升级字体版本时跑一次的工具，产物（字节 +
src/fonts.generated.ts）提交进仓库。这样构建既不依赖 Python 也不依赖公网，
`pnpm deploy --prod` 直接把字节带进镜像。

用法（需要 fonttools）：
    python3 -m pip install fonttools brotli
    python3 scripts/build-subset.py ../../fonts/NotoSansSC-Regular.otf
然后跑 `node scripts/generate-index.mjs` 重新生成索引。

所有影响输出的参数都写死在下面，不接受命令行覆盖。这只保证了**这个脚本**不引入
变量；「重跑得到逐字节相同的结果」还要求**同一份源字体 + 同一个 fontTools 版本**
——两者都没有 pin，所以升级前先对着 README「产物出处」那张表核一遍版本，对不上就
不要指望字节相同（也别为了对上而重跑：产物已提交，重跑只会换来一次不可复现的
搅动）。
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
        # fontTools 默认只保留 nameID 0–6，于是子集里 13(license) / 14(licenseURL)
        # 整条不存在（nameID 0 的版权行还在）。包一级有 OFL.txt 且已进 package.json
        # 的 files，OFL §2 的义务本来就已经满足 —— 这一行是让下次升级字体时把许可
        # 声明也一起带进字节里，而不是修一个今天存在的合规缺口。
        "--name-IDs+=13,14",
    ])
    print(f"{OUT.name}: {OUT.stat().st_size:,} bytes，覆盖 {len(unicodes)} 个码位")

if __name__ == "__main__":
    main()
