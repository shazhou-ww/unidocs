# portal WebUI 设计画布

[`../portal-webui-v0.md`](../portal-webui-v0.md) 的可交互版本。六块画板，前四块是可点击原型。

已发布画布：<https://claude.ai/code/artifact/758d6b8f-9d5d-4d06-8909-c2b57d4f2e01>

| 文件 | 画板 | 说明 |
| --- | --- | --- |
| `Main.dc.html` | Markdown · 分屏对照 | 选中正文可提评论、选中的一处可回复、逐条评论切基版 |
| `Psd.dc.html` | PSD · 分屏对照 | 同一套布局，位置类型换成框选区域 + 图层组 |
| `Home.dc.html` | 我的作品 | 卡片暴露讨论状态，顶部列 Agent 最新回复 |
| `VersionBrowse.dc.html` | 全屏回看 · 版本历史 | base parent 链与 comment provenance |
| `ThreadStates.dc.html` | Thread 状态表 | 六种 thread 状态的静态说明板 |
| `Decisions.dc.html` | 决策与未决项 | 与 `portal-webui-v0.md` 同源 |
| `canvas.json` | — | 画板布局、便签、打开时的视图 |

## 重新构建

画板源文件是 Design Component 格式（`.dc.html`）。构建产物
`unidocs-portal-canvas.html`（约 2.5 MB，内含画布编辑器）**一并入库**，这样在任何
一台机器上直接用浏览器打开它就能看（不用登录、不用联网、不依赖已发布的画布链接）。
改了画板源文件之后要重新 seed 并把产物一起提交：

```
node <design-skill>/seed-canvas.mjs \
  --template <design-skill>/payload.template.html \
  --out unidocs-portal-canvas.html \
  --title "UniDocs Portal · 评论与版本对照" \
  --artboard Main.dc.html --artboard Psd.dc.html --artboard Home.dc.html \
  --artboard VersionBrowse.dc.html --artboard ThreadStates.dc.html --artboard Decisions.dc.html \
  --canvas canvas.json
```

## 使用

- 直接用浏览器打开 `unidocs-portal-canvas.html` 即可；已发布的画布链接是私有的，
  换台没登录的机器打不开，本地文件没有这个限制（本地打开时不能保存，只能看和导出）。
- 画布总览里点击只会选中画板；要交互，点画板标题栏上的 ▶︎ 进原型模式。
- Export PDF 只收当前可见的画板 —— 导出前先确保没有画板处于展开状态，否则被遮住的
  会被排除。
