const STORAGE = 'unidocs-design-mock-v1';
const documentTypes = [{ id: 'markdown', label: 'Markdown', icon: 'file-text' }, { id: 'psd', label: 'PSD', icon: 'layers' }];
const app = document.getElementById('app');
const modal = document.getElementById('modal');
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const uid = () => crypto.randomUUID();
const seed = () => ({
  docs: [
    {
      id: 'vision', title: 'UniDocs · 产品构想', tags: ['产品', 'UniDocs'], updated: '刚刚', author: 'Agent', versions: [
        { number: 1, title: 'UniDocs · 产品构想', content: '# UniDocs\n\n为人和 AI 一起创作而设计。', author: '你' },
        { number: 2, title: 'UniDocs · 产品构想', content: '# 为共同创作，留一个空间\n\nUniDocs 是一个面向人和 AI 的数字作品创作平台。每一件作品，都可以被持续阅读、讨论和迭代。\n\n> 人负责判断与表达，Agent 负责把想法变成作品。\n\n## 01 · 从作品出发\n\n一篇文档、一张架构图、一份演示，都有一个长期存在的 session。修改不会改变作品的身份，只有主动 fork 才会产生新的作品。\n\n- 一个链接，回到同一件作品\n- 一个版本，保留当时的完整上下文\n- 一轮反馈，把修改意图交给 Agent\n\n## 02 · 人与 Agent 的创作循环\n\nAgent 可以直接创建作品，再把链接交给人。人打开后先看到内容，圈选需要讨论的部分，积累批注，再一次性交给 Agent。\n\n我们希望每一次修改，都有可追溯的上下文。\n\n## 03 · 作品之间，也有连接\n\n引用不是复制。引用固定在一个明确的版本，源作品更新时，由使用者决定是否跟进。\n\n[阅读：版本引用约定](#doc=references&v=2)\n\n## 下一步\n\n先用 Markdown 跑通创作、审阅和引用，再扩展更多内容类型。\n\n- [x] 明确 session 的长期身份\n- [x] 确定固定版本引用\n- [ ] 验证第一轮审阅体验\n- [ ] 用真实创作任务试用\n', author: 'Agent' }
      ]
    },
    {
      id: 'references', title: '版本引用约定', tags: ['设计', 'UniDocs'], updated: '18 分钟前', author: '你', versions: [
        { number: 1, title: '版本引用约定', content: '# 版本引用约定\n\n作品引用需要保持稳定。', author: '你' },
        { number: 2, title: '版本引用约定', content: '# 版本引用约定\n\n引用另一件作品时，保存它的 session 标识和明确的版本号。源作品继续迭代，不会改变已经引用的内容。\n\n## 固定，而不失联\n\n- 标题和摘要来自引用版本\n- 可以回到原作品的对应版本\n- 有新版本时，提示使用者主动更新\n\n## 预览\n\n指向引用时，展示该版本的标题与前 120 字摘要。\n\n> 稳定的是内容，持续的是联系。', author: '你' },
        { number: 3, title: '版本引用约定', content: '# 版本引用约定\n\n引用另一件作品时，保存它的 session 标识和明确的版本号。源作品继续迭代，不会改变已经引用的内容。\n\n## 固定，而不失联\n\n- 标题和摘要来自引用版本\n- 可以回到原作品的对应版本\n- 有新版本时，提示使用者主动更新\n\n## 预览\n\n指向引用时，展示该版本的标题与前 120 字摘要。触屏设备通过点击打开对应版本。\n\n## 更新引用\n\n切换引用版本属于对当前作品的一次编辑，需要保存后才生效。旧版本仍然可以追溯。\n\n> 稳定的是内容，持续的是联系。', author: 'Agent' }
      ]
    },
    { id: 'review', title: '一轮好的创作反馈', tags: ['写作', '设计'], updated: '1 小时前', author: '你', versions: [{ number: 1, title: '一轮好的创作反馈', content: '# 一轮好的创作反馈\n\n先理解作品，再表达判断。\n\n## 把问题说清楚\n\n“这里不太好”是一种感受；“这里需要先解释读者为什么关心”才是可以行动的反馈。\n\n## 留下上下文\n\n1. 选中相关内容\n2. 描述期望，而不只描述问题\n3. 必要时附上参考作品\n\n> 反馈不必长，但需要让下一步变得明确。', author: '你' }] },
    { id: 'architecture', title: '创作链路 · 技术笔记', tags: ['技术', 'UniDocs'], updated: '昨天', author: 'Agent', versions: [{ number: 1, title: '创作链路 · 技术笔记', content: '# 创作链路\n\n让不同的创作入口，访问同一份内容。\n\n## 访问方式\n\n| 参与者 | 入口 | 行为 |\n| --- | --- | --- |\n| 人 | Web UI | 查看、批注、编辑 |\n| Agent | API / MCP | 查询、修改、回复 |\n\n## 并发控制\n\n提交必须携带基础版本。基础版本落后时，拒绝写入，保留修改内容。\n\n```json\n{ "session": "vision", "baseVersion": 2 }\n```\n\n## 身份\n\n链接只定位内容，不授予访问权限。', author: 'Agent' }] },
    { id: 'fieldnotes', title: '空间与留白', tags: ['灵感', '写作'], updated: '昨天', author: '你', versions: [{ number: 1, title: '空间与留白', content: '# 空间与留白\n\n让内容成为视线的落点。\n\n![建筑的光线与空间](https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=900&q=80)\n\n## 少一点界面，多一点作品\n\n工具应该在需要时出现。审阅时，页面首先属于内容；编辑时，结构和操作才进入视野。\n\n- 柔和的边界\n- 清晰的层级\n- 不打断阅读的反馈\n\n照片：Unsplash。', author: '你' }] },
    { id: 'launch', title: '第一次真实试用', tags: ['产品'], updated: '9 月 5 日', author: '你', versions: [{ number: 1, title: '第一次真实试用', content: '# 第一次真实试用\n\n用一个真实任务，检验创作是否流畅。\n\n## 任务\n\n和 Agent 一起完成一篇产品介绍，引用一份设计约定，并完成一轮审阅。\n\n## 观察\n\n- 能否快速找到上次的作品？\n- Agent 的变化是否容易感知？\n- 批注是否足以传达修改意图？\n- 引用版本是否清晰？\n\n## 记录\n\n待试用后补充。', author: '你' }] }
  ],
  comments: [
    { id: 'comment-1', doc: 'vision', version: 2, quote: '引用不是复制。', text: '这里可以补充：更新引用需要由用户明确确认，不要自动替换。', status: 'open', draft: false, review: 'review-1', replies: [{ author: 'Agent', text: '收到。版本引用约定的 v3 已补充更新规则，当前文档仍引用 v2，等待确认。' }] },
    { id: 'comment-2', doc: 'vision', version: 2, quote: '一个版本，保留当时的完整上下文', text: '需要强调批注也锚定版本。', status: 'resolved', draft: false, review: 'review-1', replies: [{ author: 'Agent', text: '已在审阅流程中采用版本锚定。' }] }
  ], drafts: {}
});
let state;
try { state = JSON.parse(localStorage.getItem(STORAGE)) || seed(); } catch { state = seed(); }
if (!state.psdMockAdded) {
  state.docs.unshift(psdMock.sample());
  state.docs.splice(1, 0, { id: 'cover-notes', type: 'markdown', title: '共创空间 · 发布手记', tags: ['写作', 'UniDocs'], updated: '20 分钟前', author: '你', versions: [{ number: 1, title: '共创空间 · 发布手记', author: '你', content: '# 给想法一个空间\n\n这张封面，是我们与 Agent 共同创作的第一份视觉稿。\n\n![共创空间 · 封面设计](#doc=studio-cover&v=1)\n\n## 创作笔记\n\n保留轻盈的留白，让文字和空间摄影一起表达共同创作的氛围。\n\n封面已经有了新的提案，这里先保留最初版本，确认后再更新引用。' }] });
  state.psdMockAdded = true;
  try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch { }
}
let mode = 'preview';
let search = '';
let activeTag = '';
let activeType = '';
let layout = 'grid';
let selectedQuote = '';
let selectedRegion = null;
let reviewOpen = innerWidth > 760;
let reviewFilter = 'open';
let editorSelection = 0;
let editOnNavigation = null;
let conflict = false;
let toastTimer;
const latest = doc => doc.versions.at(-1);
const currentRoute = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const currentDoc = () => state.docs.find(doc => doc.id === currentRoute().doc);
const shownVersion = doc => doc.versions.find(version => version.number === Number(currentRoute().v)) || latest(doc);
function persist() { try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch { toast('本地存储不可用，请下载草稿以保留修改。'); } }
function icons() { if (window.lucide) lucide.createIcons(); }
function markdown(content) { return window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(content)) : `<pre>${escapeHtml(content)}</pre>`; }
function excerpt(content, length = 120) { if (psdMock.parse(content)) return psdMock.summary(content).slice(0, length); const element = document.createElement('div'); element.innerHTML = markdown(content); element.querySelectorAll('h1,img').forEach(node => node.remove()); return element.textContent.trim().replace(/\s+/g, ' ').slice(0, length); }
function toast(message) { const element = document.getElementById('toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 3500); }
function routeTo(hash) { mode = 'preview'; conflict = false; location.hash = hash; }
function href(doc, version) { return `#doc=${encodeURIComponent(doc)}${version ? `&v=${version}` : ''}`; }
function sidebar() {
  const tags = [...new Set(state.docs.flatMap(doc => doc.tags))];
  return `<aside class="sidebar" id="sidebar"><a href="#" class="brand"><span class="brand-mark"><img src="logo/04-studio-seal.svg" alt=""></span>UniDocs</a><div class="workspace">个人工作空间</div><nav aria-label="主导航"><button class="nav-item ${!activeTag ? 'active' : ''}" data-action="home">${icon('layout-grid')}我的作品<span class="count">${state.docs.length}</span></button></nav><div class="nav-label">标签</div><nav aria-label="标签">${tags.map(tag => `<button class="nav-item ${activeTag === tag ? 'active' : ''}" data-action="tag" data-value="${escapeHtml(tag)}"><span class="tag-dot"></span>${escapeHtml(tag)}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="row"><span class="avatar">L</span><div><div style="font-size:12px">我的工作空间</div><small style="font-size:10px">仅自己可访问</small></div>${icon('lock-keyhole')}</div><div class="prototype">交互原型 · 本地样例数据</div></div></aside>`;
}
function shell(content) { app.innerHTML = `${sidebar()}<main class="main">${content}</main><button class="icon mobile-nav" title="打开导航" aria-label="打开导航" data-action="mobile-nav">${icon('menu')}</button>`; icons(); }
function render() {
  selectedQuote = '';
  selectedRegion = null;
  document.getElementById('selection-comment').hidden = true;
  document.getElementById('reference-popover').hidden = true;
  const doc = currentDoc();
  if (currentRoute().doc && !doc) { shell('<div class="home"><h1>找不到这件作品</h1><p class="muted">此原型的链接只能定位当前浏览器中的本地作品。</p><a href="#">返回我的作品</a></div>'); return; }
  if (doc) renderDoc(doc); else renderHome();
}
function renderHome() {
  document.title = 'UniDocs · 我的作品';
  shell(`<header class="topbar"><div class="breadcrumb">工作空间 <span>/</span><span>我的作品</span></div><div class="row muted" style="font-size:11px">${icon('lock-keyhole')}仅自己可访问</div></header><section class="home"><div class="row spread home-intro"><div><div class="eyebrow">WORKSPACE / ${String(state.docs.length).padStart(2, '0')}</div><h1>我的作品</h1><p>想法、草稿，以及持续生长的作品。</p></div><button class="primary" data-action="new">${icon('plus')}新建作品</button></div><div class="filters"><div class="filter-query"><label class="search">${icon('search')}<input id="search" aria-label="搜索作品" placeholder="搜索标题或正文…" value="${escapeHtml(search)}"></label><select id="type-filter" aria-label="按类型筛选"><option value="">所有类型</option>${documentTypes.map(type => `<option value="${type.id}" ${activeType === type.id ? 'selected' : ''}>${type.label}</option>`).join('')}</select><select id="tag-filter" aria-label="按标签筛选"><option value="">所有标签</option>${[...new Set(state.docs.flatMap(doc => doc.tags))].map(tag => `<option ${activeTag === tag ? 'selected' : ''}>${escapeHtml(tag)}</option>`).join('')}</select></div><select id="sort" aria-label="作品排序"><option value="recent">最近更新</option><option value="title">标题排序</option></select><div class="grow"></div><div class="segmented" aria-label="展示方式"><button class="icon ${layout === 'grid' ? 'active' : ''}" title="网格视图" aria-label="网格视图" data-action="layout" data-value="grid">${icon('layout-grid')}</button><button class="icon ${layout === 'list' ? 'active' : ''}" title="列表视图" aria-label="列表视图" data-action="layout" data-value="list">${icon('list')}</button></div></div><div class="section-label"><span id="result-count"></span></div><div id="doc-grid" class="doc-grid ${layout === 'list' ? 'list' : ''}"></div></section>`);
  renderCards();
}
function renderCards() {
  let docs = state.docs.filter(doc => (!activeType || (doc.type || 'markdown') === activeType) && (!activeTag || doc.tags.includes(activeTag)) && (!search || `${doc.title} ${latest(doc).content} ${doc.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())));
  if (document.getElementById('sort')?.value === 'title') docs = [...docs].sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  document.getElementById('result-count').textContent = `${docs.length} 件作品${activeTag ? ' · ' + activeTag : ''}`;
  document.getElementById('doc-grid').innerHTML = docs.map((doc, index) => `<article class="doc-card" style="animation-delay:${index * 35}ms"><a class="card-link" href="${href(doc.id)}"><div class="doc-thumb ${doc.type === 'psd' ? 'psd-thumb' : ''}" aria-hidden="true">${doc.type === 'psd' ? psdMock.thumbnail(latest(doc).content) : `<div class="mini-paper">${markdown(latest(doc).content).replace(/<a\b[^>]*>/g, '<span>').replace(/<\/a>/g, '</span>')}</div>`}</div><div class="doc-info"><h2>${escapeHtml(doc.title)}</h2><div class="description">${escapeHtml(excerpt(latest(doc).content, 65))}</div><div class="row" style="gap:5px;margin-bottom:12px"><span class="tag doc-type">${doc.type === 'psd' ? 'PSD' : 'MD'}</span>${doc.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div><div class="row spread card-meta"><span class="row" style="gap:5px">${icon(doc.author === 'Agent' ? 'bot' : 'user-round')}${escapeHtml(doc.author)} · ${escapeHtml(doc.updated)}</span><span>v${latest(doc).number} ${state.drafts[doc.id] ? '· 有草稿' : ''}</span></div></div></a></article>`).join('') || '<div class="empty">没有匹配的作品</div>';
  psdMock.paintThumbnails(document.getElementById('doc-grid'));
  document.querySelectorAll('.mini-paper img[src^="#doc="]').forEach(image => {
    const params = new URLSearchParams(image.getAttribute('src').slice(1));
    const target = state.docs.find(doc => doc.id === params.get('doc'));
    const version = target?.versions.find(item => item.number === Number(params.get('v')));
    if (target?.type === 'psd' && version) { const holder = document.createElement('div'); holder.innerHTML = psdMock.thumbnail(version.content); image.replaceWith(holder); psdMock.paintThumbnails(holder); }
  });
  icons();
}
function renderDoc(doc) {
  const version = shownVersion(doc);
  const historical = version.number !== latest(doc).number;
  const draft = state.drafts[doc.id];
  const comments = state.comments.filter(comment => comment.doc === doc.id && !comment.draft && comment.status === 'open');
  const editing = mode === 'edit';
  document.title = `${doc.title} · UniDocs`;
  shell(`<header class="topbar"><div class="breadcrumb"><a href="#" title="返回我的作品">${icon('arrow-left')}</a><a href="#" class="desktop-text">我的作品</a><span>/</span><span>${escapeHtml(doc.title)}</span></div><div class="row"><button class="small ghost" data-action="copy-doc" title="复制作品链接">${icon('link')}<span class="desktop-text">复制链接</span></button><button class="icon ghost" data-action="download" title="下载 Markdown" aria-label="下载 Markdown">${icon('download')}</button><div class="menu-wrap"><button class="icon ghost" data-action="more" aria-label="更多操作" title="更多操作">${icon('ellipsis')}</button><div id="more-menu" class="dropdown" hidden><button data-action="rename">${icon('pencil')}标题与标签</button><button data-action="fork">${icon('git-fork')}Fork 此版本</button><hr><button data-action="simulate">${icon('bot')}模拟 Agent 更新</button></div></div></div></header><div class="doc-header"><h1 class="doc-title">${escapeHtml(doc.title)}</h1><div class="doc-subtitle"><span class="row" style="gap:4px">${icon('file-text')}Markdown</span><span>·</span>${doc.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}<span>·</span><span class="live-dot"></span><span>${historical ? '历史版本' : doc.author + ' 更新于' + doc.updated}</span><span class="grow"></span><span class="row" style="gap:5px">${icon('lock-keyhole')}仅自己</span></div></div><div class="row spread doc-toolbar"><div class="row mode-tabs"><button class="ghost ${!editing ? 'active' : ''}" data-action="preview">${icon('eye')}预览</button><button class="ghost ${editing ? 'active' : ''}" data-action="edit">${icon('square-pen')}编辑</button><select id="version" aria-label="查看版本">${[...doc.versions].reverse().map(item => `<option value="${item.number}" ${item.number === version.number ? 'selected' : ''}>v${item.number}${item.number === latest(doc).number ? ' · 最新' : ''}</option>`).join('')}</select>${editing ? `<span class="draft-note" id="draft-status">草稿 · 基于 v${draft?.baseVersion || version.number}</span>` : ''}</div><div class="row">${editing ? `<button class="small" data-action="insert-ref">${icon('link-2')}引用作品</button><button class="small primary" data-action="save">${icon('check')}保存</button>` : `<button class="small ghost" data-action="add-comment">${icon('message-square-plus')}添加批注</button><button class="small ${reviewOpen ? 'active' : ''}" data-action="toggle-review">${icon('panel-right')}反馈 ${comments.length}</button>`}</div></div>${historical ? `<div class="banner"><span>正在查看固定版本 v${version.number}，最新版本为 v${latest(doc).number}。</span><button class="small" data-action="latest">查看最新版 ${icon('arrow-up-right')}</button></div>` : ''}${currentRoute().review ? `<div class="banner review-link-banner"><span>正在查看一轮反馈 · ${state.comments.filter(comment => comment.review === currentRoute().review).length} 条批注</span><button class="small" data-action="all-feedback">全部反馈</button></div>` : ''}${conflict ? `<div class="banner conflict" role="alert"><span>保存被拒绝：基础版本 v${draft?.baseVersion} 已落后于 v${latest(doc).number}。你的草稿已保留。</span><div class="row"><button class="small" data-action="copy-conflict">${icon('copy')}复制冲突上下文</button><button class="small" data-action="download-draft">${icon('download')}下载草稿</button><button class="small" data-action="latest">查看最新内容</button></div></div>` : ''}<div class="doc-workspace ${editing ? 'editing' : ''}"><section class="content-area">${editing ? `<div class="editor-grid"><div class="editor-pane"><div class="pane-heading"><span>MARKDOWN</span><span>本地草稿</span></div><textarea id="source" spellcheck="false" aria-label="Markdown 源码">${escapeHtml(draft?.content ?? version.content)}</textarea></div><div class="editor-pane"><div class="pane-heading"><span>预览</span><span>尚未提交</span></div><div id="preview" class="prose editor-preview"></div></div></div>` : `<article id="preview" class="paper prose"></article>`}</section>${reviewPanel(doc)}</div>`);
  if (doc.type === 'psd') {
    document.querySelector('.doc-workspace').classList.add('psd-workspace');
    const downloadButton = document.querySelector('[data-action="download"]');
    downloadButton.title = '下载 PNG 预览'; downloadButton.setAttribute('aria-label', '下载 PNG 预览');
    document.querySelector('.doc-subtitle > span').innerHTML = `${icon('layers')}PSD`;
    const insertButton = document.querySelector('[data-action="insert-ref"]');
    if (insertButton) insertButton.remove();
    const area = document.querySelector('.content-area');
    area.classList.add('psd-content');
    const regions = state.comments.filter(comment => comment.doc === doc.id && comment.version === version.number && comment.region && (!currentRoute().comment || comment.id === currentRoute().comment)).map(comment => comment.region);
    psdMock.mount(area, editing ? (draft?.content ?? version.content) : version.content, {
      editing, regions, focusRegion: Boolean(currentRoute().comment),
      onChange: content => { saveDraft(content); document.getElementById('draft-status').textContent = `草稿已保留 · 基于 v${state.drafts[doc.id].baseVersion}`; },
      onRegion: region => { selectedRegion = region; selectedQuote = `画布区域 · X ${region.x}, Y ${region.y} · ${region.width} × ${region.height} px · 可见图层：${psdMock.parse(version.content).layers.filter(layer => region.visibleLayerIds.includes(layer.id)).map(layer => layer.name).join('、') || '无'}`; commentModal(); }
    });
    state.comments.filter(comment => comment.doc === doc.id && comment.region).forEach(comment => {
      const anchor = document.getElementById(comment.id)?.querySelector('.thread-meta a');
      if (anchor) anchor.href = href(doc.id, comment.version) + '&comment=' + comment.id;
    });
    icons();
  } else renderPreview(editing ? (draft?.content ?? version.content) : version.content);
  const source = document.getElementById('source');
  if (source) source.addEventListener('select', () => { editorSelection = source.selectionStart; });
}
function renderPreview(content) {
  const preview = document.getElementById('preview');
  preview.innerHTML = markdown(content);
  preview.querySelectorAll('img[src^="#doc="]').forEach(image => {
    const params = new URLSearchParams(image.getAttribute('src').slice(1));
    const target = state.docs.find(doc => doc.id === params.get('doc'));
    const version = target?.versions.find(item => item.number === Number(params.get('v')));
    if (target?.type !== 'psd' || !version) { image.replaceWith(document.createTextNode('引用的图片版本不可用')); return; }
    const link = document.createElement('a'); link.href = image.getAttribute('src'); link.dataset.imageRef = 'true'; link.className = 'psd-embedded';
    link.innerHTML = psdMock.thumbnail(version.content, version.title) + `<span class="psd-embedded-caption">${escapeHtml(image.alt || version.title)}</span>`;
    image.replaceWith(link);
  });
  preview.querySelectorAll('a[href^="#doc="]').forEach(anchor => {
    const params = new URLSearchParams(anchor.getAttribute('href').slice(1));
    const doc = state.docs.find(item => item.id === params.get('doc'));
    const version = doc?.versions.find(item => item.number === Number(params.get('v')));
    if (!version) return;
    anchor.classList.add('reference-link'); anchor.dataset.refDoc = doc.id; anchor.dataset.refVersion = version.number;
    if (anchor.dataset.imageRef) anchor.querySelector('.psd-embedded-caption').insertAdjacentHTML('beforeend', ` <span class="reference-version">PSD · v${version.number}</span>`);
    else anchor.innerHTML = `${escapeHtml(anchor.textContent)} <span class="reference-version">v${version.number}</span>`;
    anchor.setAttribute('aria-label', `${anchor.textContent}，打开固定版本`);
    const summary = document.createElement('span'); summary.className = 'reference-summary'; summary.textContent = excerpt(version.content, 64); anchor.after(summary);
    if (latest(doc).number > version.number) {
      const button = document.createElement('button'); button.className = 'small ghost'; button.style.cssText = 'font-size:10px;color:#8b763c;margin-left:4px'; button.dataset.action = 'ref-update'; button.dataset.doc = doc.id; button.dataset.version = version.number; button.textContent = `有新版本 v${latest(doc).number}`; summary.after(button);
    }
  });
  preview.querySelectorAll('a[href^="http"]').forEach(anchor => { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; });
  psdMock.paintThumbnails(preview);
}
function reviewPanel(doc) {
  let comments = state.comments.filter(comment => comment.doc === doc.id);
  if (currentRoute().review) comments = comments.filter(comment => comment.review === currentRoute().review);
  if (currentRoute().comment) comments = comments.filter(comment => comment.id === currentRoute().comment);
  const drafts = state.comments.filter(comment => comment.doc === doc.id && comment.draft);
  comments = comments.filter(comment => reviewFilter === 'all' || (reviewFilter === 'draft' ? comment.draft : comment.status === 'open'));
  return `<aside class="review-panel ${reviewOpen ? 'open' : ''}" aria-label="反馈面板"><div class="review-heading"><div class="row spread"><h2>讨论与批注</h2><button class="icon ghost" data-action="toggle-review" aria-label="关闭反馈面板" title="关闭反馈面板">${icon('panel-right-close')}</button></div><div class="row spread" style="margin-top:13px"><select id="review-filter" aria-label="筛选批注"><option value="open" ${reviewFilter === 'open' ? 'selected' : ''}>未解决</option><option value="all" ${reviewFilter === 'all' ? 'selected' : ''}>全部</option><option value="draft" ${reviewFilter === 'draft' ? 'selected' : ''}>我的草稿</option></select><button class="icon ghost" data-action="add-comment" title="添加批注" aria-label="添加批注">${icon('plus')}</button></div></div><div class="review-body">${comments.map(comment => threadMarkup(comment)).join('') || '<div class="empty" style="padding:36px 0">暂无批注</div>'}</div>${drafts.length ? `<div class="review-footer"><button class="primary" data-action="submit-review">提交反馈 · ${drafts.length} 条 ${icon('arrow-up-right')}</button></div>` : ''}</aside>`;
}
function threadMarkup(comment) {
  return `<section class="thread" id="${comment.id}"><div class="row spread"><span class="row"><span class="avatar">L</span><span class="author">你</span></span>${comment.draft ? '<span class="draft-status">草稿 · 仅自己可见</span>' : comment.status === 'resolved' ? '<span class="resolved">已解决</span>' : ''}</div><div class="thread-meta"><a href="${href(comment.doc, comment.version)}">v${comment.version} ${icon('corner-up-left')}</a>${comment.draft ? '' : ' · 已提交'}</div>${comment.quote ? `<div class="quote">${escapeHtml(comment.quote)}</div>` : ''}<p>${escapeHtml(comment.text)}</p><div class="row spread">${comment.draft ? `<button class="small ghost" data-action="edit-comment" data-id="${comment.id}">${icon('pencil')}编辑</button><button class="icon ghost" data-action="delete-comment" data-id="${comment.id}" title="删除草稿" aria-label="删除草稿">${icon('trash-2')}</button>` : `<button class="small ghost" data-action="resolve" data-id="${comment.id}">${icon(comment.status === 'open' ? 'check' : 'rotate-ccw')}${comment.status === 'open' ? '解决' : '重新打开'}</button><button class="icon ghost" data-action="copy-comment" data-id="${comment.id}" title="复制批注链接" aria-label="复制批注链接">${icon('link')}</button>`}</div>${comment.replies.map(reply => `<div class="reply"><div class="row"><span class="avatar ${reply.author === 'Agent' ? 'agent' : ''}">${reply.author === 'Agent' ? icon('bot') : 'L'}</span><span class="author">${escapeHtml(reply.author)}</span></div><p>${escapeHtml(reply.text)}</p></div>`).join('')}${!comment.draft ? `<form data-reply="${comment.id}" class="stack" style="gap:6px;margin-top:12px"><textarea name="reply" aria-label="回复批注" placeholder="回复…" rows="2" required></textarea><button class="small ghost" type="submit" style="align-self:flex-end">${icon('corner-down-left')}回复</button></form>` : ''}</section>`;
}
function openModal(title, body, footer = '') {
  modal.innerHTML = `<div class="modal-head row spread"><h2>${title}</h2><button class="icon ghost" data-action="close-modal" title="关闭" aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  if (!modal.open) modal.showModal(); icons();
}
function commentModal(existing) {
  const doc = currentDoc(); const version = shownVersion(doc);
  if (existing) selectedRegion = existing.region || null;
  const quote = existing?.quote || selectedQuote;
  document.getElementById('selection-comment').hidden = true;
  openModal(existing ? '编辑批注' : '添加批注', `<div class="row spread" style="margin-bottom:14px"><span class="tag">${escapeHtml(doc.title)} · v${existing?.version || version.number}</span><span class="draft-status">草稿</span></div>${quote ? `<div class="quote">${escapeHtml(quote)}</div>` : '<div class="muted" style="margin-bottom:12px;font-size:11px">整篇作品</div>'}<textarea id="comment-text" aria-label="批注内容" placeholder="你希望调整什么？" rows="5">${escapeHtml(existing?.text || '')}</textarea>`, `<button data-action="close-modal">取消</button><button class="primary" data-action="save-comment" data-id="${existing?.id || ''}" data-doc="${doc.id}" data-version="${existing?.version || version.number}" data-quote="${escapeHtml(quote)}">保存批注草稿</button>`);
  document.getElementById('comment-text').focus();
}
function referenceModal() {
  const source = document.getElementById('source'); editorSelection = source?.selectionStart ?? editorSelection;
  openModal('引用作品', `<label class="search" style="display:block;max-width:none">${icon('search')}<input id="ref-search" aria-label="搜索引用作品" placeholder="搜索标题、内容或标签…"></label><div class="ref-results" id="ref-results"></div>`);
  renderRefResults('');
}
function renderRefResults(query) {
  document.getElementById('ref-results').innerHTML = state.docs.filter(doc => doc.id !== currentDoc().id && `${doc.title} ${latest(doc).content} ${doc.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())).map(doc => `<button class="ref-option" data-action="choose-ref" data-id="${doc.id}">${doc.type === 'psd' ? psdMock.thumbnail(latest(doc).content) : icon('file-text')}<span class="grow"><strong>${escapeHtml(doc.title)} <span class="tag">${doc.type === 'psd' ? 'PSD · 图片引用' : 'Markdown'} · v${latest(doc).number}</span></strong><small>${escapeHtml(excerpt(latest(doc).content, 85))}</small></span>${icon('plus')}</button>`).join('') || '<div class="empty">没有匹配的作品</div>'; psdMock.paintThumbnails(document.getElementById('ref-results')); icons();
}
function saveDraft(content) { const doc = currentDoc(); const draft = state.drafts[doc.id]; state.drafts[doc.id] = { content, baseVersion: draft?.baseVersion ?? shownVersion(doc).number }; persist(); }
function setSource(content) { saveDraft(content); document.getElementById('source').value = content; renderPreview(content); }
function commitDraft() {
  const doc = currentDoc(); const draft = state.drafts[doc.id];
  if (!draft) { toast('没有待保存的修改'); return; }
  if (draft.baseVersion !== latest(doc).number) { conflict = true; render(); return; }
  if (draft.content === latest(doc).content) { delete state.drafts[doc.id]; persist(); mode = 'preview'; render(); toast('内容没有变化'); return; }
  doc.versions.push({ number: latest(doc).number + 1, title: doc.title, content: draft.content, author: '你' }); doc.updated = '刚刚'; doc.author = '你';
  delete state.drafts[doc.id]; state.docs = [doc, ...state.docs.filter(item => item.id !== doc.id)]; persist(); mode = 'preview'; conflict = false;
  if (currentRoute().v) location.hash = href(doc.id); else render(); toast(`已保存为 v${latest(doc).number}`);
}
async function copyText(text, message = '链接已复制') {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { openModal('复制内容', `<textarea readonly rows="5" aria-label="待复制内容">${escapeHtml(text)}</textarea>`); modal.querySelector('textarea').select(); }
}
function absoluteLink(hash) { return location.href.split('#')[0] + hash; }
function download(content, name) { const psd = currentDoc()?.type === 'psd'; const url = URL.createObjectURL(new Blob([content], { type: psd ? 'application/json' : 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name.replace(/[<>:"/\\|?*]/g, '-') + (psd ? '.mock.json' : '.md'); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function createDoc(fork = false, type = 'markdown') {
  const source = currentDoc(); const id = uid(); const title = fork ? `${source.title} · 副本` : '未命名';
  const content = fork ? shownVersion(source).content : type === 'psd' ? psdMock.initial() : '';
  state.docs.unshift({ id, title, type: fork ? (source.type || 'markdown') : type, tags: fork ? [...source.tags] : [], updated: '刚刚', author: '你', versions: [{ number: 1, title, content, author: '你' }] }); persist();
  editOnNavigation = fork ? null : id; location.hash = href(id); if (!fork) { state.drafts[id] = { content, baseVersion: 1 }; persist(); }
}
async function action(name, element) {
  const doc = currentDoc();
  switch (name) {
    case 'new': openModal('新建作品', `<div class="field-label">选择类型</div><div class="creation-types">${documentTypes.map(type => `<button class="creation-type" data-action="create-type" data-type="${type.id}"><span class="type-icon">${icon(type.icon)}</span><strong>${type.label}</strong>${icon('arrow-up-right')}</button>`).join('')}</div>`); break;
    case 'create-type': if (documentTypes.some(type => type.id === element.dataset.type)) { modal.close(); createDoc(false, element.dataset.type); } break;
    case 'fork': createDoc(true); toast('已创建独立作品'); break;
    case 'home': activeTag = ''; activeType = ''; search = ''; if (location.hash) location.hash = ''; else render(); break;
    case 'tag': activeTag = activeTag === element.dataset.value ? '' : element.dataset.value; if (location.hash) location.hash = ''; else render(); break;
    case 'layout': layout = element.dataset.value; renderHome(); break;
    case 'mobile-nav': document.getElementById('sidebar').classList.toggle('open'); break;
    case 'more': document.getElementById('more-menu').hidden = !document.getElementById('more-menu').hidden; break;
    case 'preview': mode = 'preview'; conflict = false; render(); break;
    case 'edit': mode = 'edit'; if (!state.drafts[doc.id]) saveDraft(shownVersion(doc).content); render(); break;
    case 'save': commitDraft(); break;
    case 'latest': mode = 'preview'; conflict = false; routeTo(href(doc.id)); render(); break;
    case 'all-feedback': routeTo(href(doc.id)); render(); break;
    case 'toggle-review': reviewOpen = !reviewOpen; document.querySelector('.review-panel').classList.toggle('open', reviewOpen); break;
    case 'add-comment': if (mode === 'edit') { toast('请先保存内容，再对版本添加批注'); return; } selectedRegion = null; if (doc.type === 'psd') selectedQuote = ''; commentModal(); break;
    case 'close-modal': modal.close(); break;
    case 'save-comment': {
      const text = document.getElementById('comment-text').value.trim(); if (!text) { document.getElementById('comment-text').focus(); return; }
      const existing = state.comments.find(comment => comment.id === element.dataset.id);
      if (existing) existing.text = text; else state.comments.push({ id: uid(), doc: element.dataset.doc, version: Number(element.dataset.version), quote: element.dataset.quote, region: selectedRegion, text, status: 'open', draft: true, replies: [] });
      persist(); modal.close(); reviewOpen = true; reviewFilter = 'open'; render(); toast('批注已存为草稿'); break;
    }
    case 'edit-comment': commentModal(state.comments.find(comment => comment.id === element.dataset.id)); break;
    case 'delete-comment': state.comments = state.comments.filter(comment => comment.id !== element.dataset.id); persist(); render(); break;
    case 'resolve': { const comment = state.comments.find(item => item.id === element.dataset.id); comment.status = comment.status === 'open' ? 'resolved' : 'open'; persist(); render(); break; }
    case 'submit-review': {
      const drafts = state.comments.filter(comment => comment.doc === doc.id && comment.draft);
      openModal('提交这一轮反馈', `<div class="muted" style="font-size:12px;margin-bottom:10px">${drafts.length} 条批注 · ${escapeHtml(doc.title)}</div>${drafts.map(comment => `<div class="review-item"><span class="tag">v${comment.version}</span><p>${escapeHtml(comment.text)}</p></div>`).join('')}`, `<button data-action="close-modal">继续审阅</button><button class="primary" data-action="confirm-review">${icon('send')}提交反馈</button>`); break;
    }
    case 'confirm-review': {
      const review = uid(); const drafts = state.comments.filter(comment => comment.doc === doc.id && comment.draft); if (!drafts.length) return;
      drafts.forEach(comment => { comment.draft = false; comment.review = review; }); persist(); render();
      openModal('反馈已提交', `<div class="row" style="margin-bottom:18px"><span class="avatar agent">${icon('check')}</span><span>${drafts.length} 条批注已提交</span></div><label class="field-label" for="review-url">本轮反馈链接</label><input id="review-url" style="width:100%" readonly value="${escapeHtml(absoluteLink(href(doc.id) + '&review=' + review))}">`, `<button data-action="close-modal">完成</button><button class="primary" data-action="copy-review" data-id="${review}">${icon('copy')}复制链接给 Agent</button>`); break;
    }
    case 'copy-review': await copyText(absoluteLink(href(doc.id) + '&review=' + element.dataset.id)); break;
    case 'copy-doc': await copyText(absoluteLink(href(doc.id, currentRoute().v))); break;
    case 'copy-comment': { const comment = state.comments.find(item => item.id === element.dataset.id); await copyText(absoluteLink(href(doc.id, comment.version) + '&comment=' + element.dataset.id)); break; }
    case 'download': if (doc.type === 'psd') { try { await psdMock.exportPng(shownVersion(doc).content, doc.title); } catch (error) { toast(error.message); } } else download(shownVersion(doc).content, doc.title); break;
    case 'download-draft': download(state.drafts[doc.id].content, doc.title + '-草稿'); break;
    case 'copy-conflict': await copyText(JSON.stringify({ session: absoluteLink(href(doc.id)), baseVersion: state.drafts[doc.id].baseVersion, latestVersion: latest(doc).number, base: doc.versions.find(version => version.number === state.drafts[doc.id].baseVersion)?.content, draft: state.drafts[doc.id].content, latest: latest(doc).content }, null, 2), '冲突上下文已复制'); break;
    case 'insert-ref': referenceModal(); break;
    case 'choose-ref': {
      const target = state.docs.find(item => item.id === element.dataset.id); const source = document.getElementById('source');
      const label = target.title.replace(/[\[\]\\]/g, ''); const link = target.type === 'psd' ? `\n\n![${label}](${href(target.id, latest(target).number)})\n\n` : `[${label}](${href(target.id, latest(target).number)})`;
      setSource(source.value.slice(0, editorSelection) + link + source.value.slice(editorSelection)); modal.close(); source.focus(); source.setSelectionRange(editorSelection + link.length, editorSelection + link.length); toast(`已引用 ${target.title} · v${latest(target).number}`); break;
    }
    case 'ref-update': {
      const target = state.docs.find(item => item.id === element.dataset.doc); const old = target.versions.find(version => version.number === Number(element.dataset.version));
      openModal('引用有新版本', `<div class="stack"><strong>${escapeHtml(target.title)}</strong><div class="${target.type === 'psd' ? 'psd-version-comparison' : 'stack'}"><div><span class="tag">当前引用 v${old.number}</span>${target.type === 'psd' ? psdMock.thumbnail(old.content) : ''}<p class="muted" style="font-size:12px;margin-top:10px">${escapeHtml(excerpt(old.content))}</p></div><div><span class="tag">最新 v${latest(target).number}</span>${target.type === 'psd' ? psdMock.thumbnail(latest(target).content) : ''}<p class="muted" style="font-size:12px;margin-top:10px">${escapeHtml(excerpt(latest(target).content))}</p></div></div><a href="${href(target.id, latest(target).number)}" data-close-dialog class="inline-state">打开最新版本 ↗</a></div>`, `<button data-action="close-modal">保留当前版本</button><button class="primary" data-action="apply-ref-update" data-id="${target.id}" data-version="${old.number}">${icon('refresh-cw')}在草稿中更新</button>`); psdMock.paintThumbnails(modal); break;
    }
    case 'apply-ref-update': { const target = state.docs.find(item => item.id === element.dataset.id); if (!state.drafts[doc.id]) saveDraft(shownVersion(doc).content); mode = 'edit'; const draft = state.drafts[doc.id]; draft.content = draft.content.split(`](${href(target.id, Number(element.dataset.version))})`).join(`](${href(target.id, latest(target).number)})`); persist(); modal.close(); render(); toast('引用已更新到草稿，保存后生效'); break; }
    case 'rename': openModal('标题与标签', `<div class="field"><label class="field-label" for="doc-name">标题</label><input id="doc-name" value="${escapeHtml(doc.title)}"></div><div class="field"><label class="field-label" for="doc-tags">标签</label><input id="doc-tags" placeholder="产品, 设计" value="${escapeHtml(doc.tags.join(', '))}"></div>`, `<button data-action="close-modal">取消</button><button class="primary" data-action="save-meta">保存</button>`); break;
    case 'save-meta': { const title = document.getElementById('doc-name').value.trim(); if (!title) return; doc.title = title; doc.tags = [...new Set(document.getElementById('doc-tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))]; doc.versions.push({ ...latest(doc), number: latest(doc).number + 1, title, author: '你' }); doc.author = '你'; doc.updated = '刚刚'; persist(); modal.close(); render(); toast('作品信息已更新'); break; }
    case 'simulate': {
      doc.versions.push({ number: latest(doc).number + 1, title: doc.title, content: doc.type === 'psd' ? psdMock.agentUpdate(latest(doc).content) : latest(doc).content + '\n\n## 本轮更新\n\n已补充审阅约定：每条批注都保留创建时的版本上下文，引用更新由用户明确确认。', author: 'Agent' }); doc.author = 'Agent'; doc.updated = '刚刚';
      const comment = state.comments.find(item => item.doc === doc.id && !item.draft && item.status === 'open'); if (comment) comment.replies.push({ author: 'Agent', text: `已更新至 v${latest(doc).number}，请查看本轮补充。原批注仍保留在 v${comment.version}。` }); persist(); render(); toast(`Agent 已提交 v${latest(doc).number}`); break;
    }
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (button) { action(button.dataset.action, button); return; }
  if (event.target.closest('[data-close-dialog]')) modal.close();
  if (event.target === modal) modal.close();
  const menu = document.getElementById('more-menu'); if (menu && !event.target.closest('.menu-wrap')) menu.hidden = true;
});
document.addEventListener('input', event => {
  if (event.target.id === 'search') { search = event.target.value; renderCards(); }
  if (event.target.id === 'ref-search') renderRefResults(event.target.value);
  if (event.target.id === 'source') { saveDraft(event.target.value); renderPreview(event.target.value); document.getElementById('draft-status').textContent = `草稿已保留 · 基于 v${state.drafts[currentDoc().id].baseVersion}`; }
});
document.addEventListener('change', event => {
  if (event.target.id === 'type-filter') { activeType = event.target.value; renderCards(); }
  if (event.target.id === 'tag-filter') { activeTag = event.target.value; renderCards(); }
  if (event.target.id === 'sort') renderCards();
  if (event.target.id === 'review-filter') { reviewFilter = event.target.value; render(); }
  if (event.target.id === 'version') { mode = 'preview'; routeTo(href(currentDoc().id, Number(event.target.value))); }
});
document.addEventListener('submit', event => {
  const id = event.target.dataset.reply; if (!id) return; event.preventDefault(); const text = new FormData(event.target).get('reply').trim(); if (!text) return;
  state.comments.find(comment => comment.id === id).replies.push({ author: '你', text }); persist(); render(); toast('回复已发布');
});
document.addEventListener('selectionchange', () => {
  const selection = getSelection(); const preview = document.getElementById('preview');
  const button = document.getElementById('selection-comment');
  if (mode !== 'edit' && !modal.open && selection && !selection.isCollapsed && preview?.contains(selection.anchorNode) && preview.contains(selection.focusNode)) {
    selectedQuote = selection.toString().trim().slice(0, 800);
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    button.hidden = !selectedQuote; button.style.left = Math.max(12, Math.min(bounds.right - 90, innerWidth - 112)) + 'px'; button.style.top = Math.max(12, Math.min(bounds.bottom + 8, innerHeight - 55)) + 'px';
  } else { button.hidden = true; if (!modal.open && selection?.isCollapsed) selectedQuote = ''; }
});
document.addEventListener('mouseover', event => {
  const anchor = event.target.closest('[data-ref-doc]'); if (!anchor) return;
  const doc = state.docs.find(item => item.id === anchor.dataset.refDoc); const version = doc.versions.find(item => item.number === Number(anchor.dataset.refVersion));
  const popover = document.getElementById('reference-popover'); popover.innerHTML = `<div class="row spread"><span class="tag">${doc.type === 'psd' ? 'PSD' : 'Markdown'}</span><span class="muted">固定版本 v${version.number}</span></div><strong style="margin-top:12px">${escapeHtml(version.title)}</strong>${doc.type === 'psd' ? psdMock.thumbnail(version.content) : ''}<p>${escapeHtml(excerpt(version.content))}</p>`;
  psdMock.paintThumbnails(popover);
  const bounds = anchor.getBoundingClientRect(); popover.hidden = false; popover.style.left = Math.max(12, Math.min(bounds.left, innerWidth - 312)) + 'px'; popover.style.top = Math.max(12, Math.min(bounds.bottom + 8, innerHeight - popover.offsetHeight - 12)) + 'px';
});
document.addEventListener('mouseout', event => { if (event.target.closest('[data-ref-doc]')) document.getElementById('reference-popover').hidden = true; });
document.getElementById('selection-comment').addEventListener('mousedown', event => event.preventDefault());
document.addEventListener('scroll', () => { document.getElementById('reference-popover').hidden = true; document.getElementById('selection-comment').hidden = true; }, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { document.getElementById('reference-popover').hidden = true; document.getElementById('selection-comment').hidden = true; document.getElementById('sidebar')?.classList.remove('open'); } });
matchMedia('(max-width: 760px)').addEventListener('change', event => { if (event.matches) modal.close(); });
window.addEventListener('hashchange', () => { modal.close(); conflict = false; mode = editOnNavigation === currentRoute().doc ? 'edit' : 'preview'; editOnNavigation = null; if (currentRoute().review || currentRoute().comment) { reviewOpen = true; reviewFilter = 'all'; } render(); window.scrollTo(0, 0); });
window.addEventListener('storage', event => { if (event.key === STORAGE && event.newValue) { try { state = JSON.parse(event.newValue); render(); toast('作品已同步'); } catch { toast('本地数据无法读取'); } } });
if (currentRoute().review || currentRoute().comment) { reviewOpen = true; reviewFilter = 'all'; }
render();