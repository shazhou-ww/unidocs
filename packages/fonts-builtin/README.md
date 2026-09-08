# @unidocs/fonts-builtin

随安装包发行的默认字体。`setText` 因此在任何新环境、任何新租户上零配置可用 ——
在它之前，那取决于有没有人对着这个环境跑过一次 `scripts/seed-psd-fonts.mjs`，
而没跑过的表现不是报错，是中文层整层画不出来。

| 文件 | 来源 | 体积 |
| --- | --- | --- |
| `fonts/NotoSans-Regular.ttf` | Noto Sans，全量 | 621 KB |
| `fonts/NotoSansSC-Regular.subset.otf` | Noto Sans SC，按 `charset/tongyong-guifan-8105.txt` 子集化 | 1.91 MB |

两套都是 OFL，允许分发，见 `OFL.txt`。子集同样受 OFL 约束。

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
