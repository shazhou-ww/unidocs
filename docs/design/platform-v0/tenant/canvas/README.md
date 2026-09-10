# tenant WebUI 设计画布

[`../tenant-webui-v0.md`](../tenant-webui-v0.md) 的可交互版本。六块画板，前四块是可点击原型。

已发布画布：<https://claude.ai/code/artifact/758d6b8f-9d5d-4d06-8909-c2b57d4f2e01>

| 文件 | 画板 | 说明 |
| --- | --- | --- |
| `Main.dc.html` | Markdown · 分屏对照 | 选中正文可提评论、选中的一处可回复、逐条评论切基版 |
| `Psd.dc.html` | PSD · 分屏对照 | 同一套布局，位置类型换成框选区域 + 图层组 |
| `Home.dc.html` | 我的作品 | 卡片暴露讨论状态，顶部列 Agent 最新回复 |
| `VersionBrowse.dc.html` | 全屏回看 · 版本历史 | base parent 链与 comment provenance |
| `ThreadStates.dc.html` | Thread 状态表 | 六种 thread 状态的静态说明板 |
| `Decisions.dc.html` | 决策与未决项 | 与 `tenant-webui-v0.md` 同源 |
| `canvas.json` | — | 画板布局、便签、打开时的视图 |

## 重新构建

画板源文件是 Design Component 格式（`.dc.html`）。构建产物
`unidocs-tenant-thread-ui.html`（约 2.5 MB，内含画布编辑器）**不入库**，需要时用
Claude Code 的 `design` skill 重新 seed：

```
node <design-skill>/seed-canvas.mjs \
  --template <design-skill>/payload.template.html \
  --out unidocs-tenant-thread-ui.html \
  --title "UniDocs 租户端 · Thread 与版本对照" \
  --artboard Main.dc.html --artboard Psd.dc.html --artboard Home.dc.html \
  --artboard VersionBrowse.dc.html --artboard ThreadStates.dc.html --artboard Decisions.dc.html \
  --canvas canvas.json
```

## 使用

- 画布总览里点击只会选中画板；要交互，点画板标题栏上的 ▶︎ 进原型模式。
- Export PDF 只收当前可见的画板 —— 导出前先确保没有画板处于展开状态，否则被遮住的
  会被排除。
