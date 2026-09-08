# @unidocs/fonts-builtin

随安装包发行的默认字体。`setText` 因此在任何新环境、任何新租户上零配置可用 ——
在它之前，那取决于有没有人对着这个环境跑过一次 `scripts/seed-psd-fonts.mjs`，
而没跑过的表现不是报错，是中文层整层画不出来。

| 文件 | 来源 | 体积 |
| --- | --- | --- |
| `fonts/NotoSans-Regular.ttf` | Noto Sans，全量 | 607 KiB（621,572 B） |
| `fonts/NotoSansSC-Regular.subset.otf` | Noto Sans SC，按 `charset/tongyong-guifan-8105.txt` 子集化 | 1.91 MiB（2,002,388 B） |

两套都是 OFL，允许分发，见 `OFL.txt`。子集同样受 OFL 约束。

## 产物出处

「重跑得到相同结果」不是脚本自己就能保证的性质 —— `build-subset.py` 只保证**它**
不引入变量（所有影响输出的参数写死、不接受命令行覆盖），源字体和 fontTools 都**没有
pin**。所以这里把当时那次的三个版本记下来，升级前先核一遍；对不上就不要指望字节相同。

| | 版本 | 下载处（同 `scripts/psd-font-bootstrap.mjs`） |
| --- | --- | --- |
| `NotoSans-Regular.ttf`（未子集化，原样提交） | `2.015`（name ID 5：`Version 2.015; ttfautohint (v1.8.4.7-5d5b)`） | `notofonts/notofonts.github.io` 的 `fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf` |
| 子集的源 `NotoSansSC-Regular.otf` | `2.004`（name ID 5：`Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603`） | `notofonts/noto-cjk` 的 `Sans/SubsetOTF/SC/NotoSansSC-Regular.otf` |
| 跑子集化的 fontTools | `4.64.0` | `python3 -c "import fontTools; print(fontTools.version)"` |

前两行的版本号直接读自仓库里这两份字节的 `name` 表（子集保留了源字体的
name ID 3/5），不是从别处抄来的：

```bash
python3 -c "
from fontTools.ttLib import TTFont
for f in ['fonts/NotoSans-Regular.ttf', 'fonts/NotoSansSC-Regular.subset.otf']:
    print(f, TTFont(f, lazy=True)['name'].getDebugName(5))"
```

**子集里没有 name ID 13/14**（license / licenseURL）：fontTools 默认只保留
nameID 0–6，而源字体的许可声明在 13/14 上。nameID 0 的版权行**在**，包一级有
`OFL.txt` 且已进 `package.json` 的 `files`，所以 OFL §2 的分发义务已经满足 ——
这不是一个待修的合规问题。`build-subset.py` 已加上 `--name-IDs+=13,14`，下次升级
字体时会自动把它们带进去；**不为此单独重跑子集**：两个版本都没 pin，重跑只会换来
一份可能字节不同的 2 MB 二进制加一份重新生成的万行索引。

## 升级字体版本

产物提交进仓库，**不在构建流程里生成** —— 构建因此既不依赖 Python 也不依赖公网。
代价是升级要有人手工跑一次：

```bash
python3 -m pip install fonttools brotli
python3 scripts/build-subset.py <全量 NotoSansSC-Regular.otf 的路径>
node scripts/generate-index.mjs
pnpm --filter @unidocs/fonts-builtin test
```

`src/fonts.generated.ts` 是生成物，**不要手改**：`tests/generated-index.test.ts`
会从字节重新解析并逐字段比对，手改会当场变红。

## 为什么是 8105 字

`charset/tongyong-guifan-8105.txt` 是《通用规范汉字表》。挑它不是因为体积合适，是
因为它是一份公开固定可引用的字表 —— 「装哪些字」于是有了可复现的依据，而不是一个
拍脑袋的数字。字表内容取自两个互不相干的公开仓库，两份**逐字相同**，这就是它的可信
来源。

港台字形、生僻人名地名字不在其中：那些字要用，走 CAS 装全量字体覆盖同名条目即可
（`scripts/seed-psd-fonts.mjs`）。内置这套保证的是**不出现空白字形**，不是还原原稿。
