(() => {
  'use strict';
  const app = document.getElementById('admin-app');
  const modal = document.getElementById('admin-modal');
  const nav = document.getElementById('admin-nav');
  const me = 'lee@example.com';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const ico = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const drawIcons = () => window.lucide?.createIcons();
  const btn = (action, label, icon, attrs = '') => `<button type="button" data-action="${action}" ${attrs}>${ico(icon)}${label}</button>`;
  const iconBtn = (action, label, icon, attrs = '') => `<button type="button" class="icon ghost" data-action="${action}" title="${label}" aria-label="${label}" ${attrs}>${ico(icon)}</button>`;
  const tone = (label, kind = '') => `<span class="admin-status ${kind}">${esc(label)}</span>`;
  const sub = value => `<span class="admin-secondary">${esc(value)}</span>`;
  const code = value => `<span class="admin-mono">${esc(value)}</span>`;
  const short = value => `${value.slice(0, 7)}…${value.slice(-5)}`;
  const bundle = (id, type, date, size, current = false, name = 'View bundle', description = '') => ({ id, type, name, description, date, size, current, protocol: 'unidocs-view-bundle/v1', entry: 'index.html', contracts: [1], locations: type === 'psd' ? ['canvas-point', 'layer'] : type === 'diagram' ? ['node', 'edge'] : ['text-range'] });
  const typeCardBundle = (id, date, size, glyph, locales, current = false, name = 'Type card bundle', description = '') => ({ id, name, description, date, size, glyph, locales, current, protocol: 'unidocs-type-card/v1', icon: { kind: 'svg', path: 'icon.svg' }, thumbnail: 'sample-thumbnail.webp' });
  const operator = (name, id, url, date, current = false, description = '') => ({ name, description, id, url, date, current, protocol: 'unidocs-operator/v1', contracts: [1] });
  const snapshotContract = (idx, contentType, date, schemaHash, schema) => ({ idx, contentType, date, schemaHash, schema });
  const state = {
    types: [
      { id: 'markdown', name: 'Markdown', text: '文本、笔记与结构化写作', icon: 'file-text', enabled: true, documents: 128, updated: '今天 10:32', etag: 'cfg-18', operators: [operator('Markdown 写作代理', 'markdown-operator', 'https://operator-markdown.example.com/', '今天 09:55', true, '稳定的生产处理服务'), operator('Markdown 写作代理预览版', 'markdown-next', 'https://operator-markdown-next.example.com/', '昨天 15:20', false, '用于验证新模型能力')], bundles: [bundle('vb_7fa912d40e83c38a', 'markdown', '今天 10:32', '184 KB', true, 'Markdown 主界面', '当前生产界面包'), bundle('vb_b126bc3e95278d17', 'markdown', '08-29 16:18', '179 KB', false, 'Markdown 稳定版', '上一个生产界面包'), bundle('vb_163ec94b108af214', 'markdown', '08-12 09:44', '171 KB', false, 'Markdown 旧版', '保留用于回溯')] },
      { id: 'psd', name: 'PSD', text: '图层、画布与视觉创作', icon: 'layers', enabled: true, documents: 46, updated: '今天 09:18', etag: 'cfg-07', operators: [operator('画布操作代理', 'psd-canvas', 'https://operator-psd.example.com/', '今天 09:18', true)], bundles: [bundle('vb_4db2794e86c811a9', 'psd', '今天 09:18', '2.8 MB', true), bundle('vb_f51cd740631af822', 'psd', '08-21 13:05', '2.6 MB')] },
      { id: 'docx', name: 'Word 文档', text: '排版文档与格式交换', icon: 'file-type-2', enabled: false, documents: 83, updated: '昨天 17:40', etag: 'cfg-11', operators: [], bundles: [bundle('vb_98c1f24da7e503bc', 'docx', '昨天 17:40', '736 KB', true)] }
    ],
    admins: [{ email: me, bound: true, by: '初始化', date: '2026-09-01' }, { email: 'chen@example.com', bound: true, by: me, date: '2026-09-05' }],
    audit: [
      ['今天 10:32', me, '切换视图包', 'markdown', 'vb_b126…78d17 → vb_7fa9…3c38a'],
      ['今天 10:29', me, '上传视图包', 'markdown', 'vb_7fa9…3c38a · 184 KB · 验证通过'],
      ['今天 09:18', 'chen@example.com', '验证操作代理', 'psd', '协议、Webhook 验签与服务身份通过'],
      ['昨天 17:40', me, '停用类型', 'docx', '等待内置操作代理接入']
    ]
  };
  const operators = {
    'https://operator-markdown.example.com/': ['Markdown 写作代理', 'markdown-operator', ['markdown']],
    'https://operator-markdown-next.example.com/': ['Markdown 写作代理预览版', 'markdown-next', ['markdown']],
    'https://operator-psd.example.com/': ['画布操作代理', 'psd-canvas', ['psd']],
    'https://operator-docx.example.com/': ['文档写作代理', 'docx-writer', ['docx']],
    'https://operator-multi.example.com/': ['UniDocs 通用代理', 'generalist', ['markdown', 'diagram']]
  };
  const sections = [['types', '文档类型', 'shapes'], ['admins', '管理员', 'users-round'], ['audit', '审计', 'history']];
  const route = () => { const p = new URLSearchParams(location.hash.slice(1)); return { page: p.get('view') || 'types', id: p.get('id') || '' }; };
  const href = (page, id = '') => `#view=${page}${id ? `&id=${id}` : ''}`;
  const activeBundle = item => item.bundles.find(item => item.current);
  const activeTypeCardBundle = item => item.typeCardBundles.find(item => item.current);
  const activeOperator = item => item.operators.find(item => item.current);
  const publicName = item => activeTypeCardBundle(item)?.locales.en.name || item.name;
  const publicDescription = item => activeTypeCardBundle(item)?.locales.en.description || '';
  const englishCopy = {
    markdown: ['Markdown', 'Text, notes and structured writing'],
    psd: ['PSD', 'Layers, canvases and visual creation'],
    docx: ['Word document', 'Formatted documents and file exchange']
  };
  for (const item of state.types) {
    item.chineseName = item.name;
    item.chineseDescription = item.text;
    [item.name, item.text] = englishCopy[item.id];
    item.typeCardBundles = [typeCardBundle(`tb_${item.id}9f1428cd`, item.updated, item.id === 'psd' ? '164 KB' : '118 KB', item.icon, { en: { name: item.name, description: item.text }, zh: { name: item.chineseName, description: item.chineseDescription } }, true, `${item.name} 创建卡片`, '主站创建入口使用的卡片资源')];
    item.snapshotContracts = [snapshotContract(1, `application/vnd.unidocs.${item.id}.snapshot+value;v=1`, item.updated, `sha256:${item.id}81f2…9ac4`, { $schema: 'https://schemas.unidocs.dev/svalue/v1', type: 'object' })];
  }
  let tab = 'config';
  let query = '';
  let filter = '';
  let context = null;
  let toastTimer;

  function toast(message) { const el = document.getElementById('admin-toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000); }
  function log(action, target, detail) { state.audit.unshift([new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), me, action, target, detail]); }
  function navigation() { return sections.map(([id, label, icon]) => `<a class="admin-nav-item ${route().page === id ? 'active' : ''}" href="${href(id)}">${ico(icon)}${label}${id === 'types' ? `<span class="nav-count">0${state.types.length}</span>` : ''}</a>`).join(''); }
  function shell(content, detail = '') {
    const section = sections.find(([id]) => id === route().page) || sections[0];
    document.title = `UniDocs 管理 · ${detail || section[1]}`;
    app.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar"><a class="admin-brand" href="#view=types"><img src="../../logo/04-studio-seal.svg" alt="">UniDocs</a><div class="admin-workspace">管理工作空间</div><nav>${navigation()}</nav><div class="admin-sidebar-bottom"><div class="row"><span class="admin-avatar">LS</span><div class="grow"><div>Lee <span class="admin-tag">管理员</span></div><div class="account-email">${me}</div></div>${iconBtn('logout', '退出', 'log-out')}</div></div></aside><main class="admin-main"><header class="admin-topbar"><div class="admin-crumb"><span>管理工作空间</span><span>/</span><a href="${href(section[0])}">${section[1]}</a>${detail ? `<span>/</span><span>${esc(detail)}</span>` : ''}</div><div class="row"><span class="admin-environment">${ico('flask-conical')}沙盒</span><button type="button" class="icon ghost admin-menu" data-action="navigation" title="打开导航" aria-label="打开导航">${ico('menu')}</button></div></header><div class="admin-content">${content}</div></main></div>`;
    drawIcons();
  }
  const heading = (title, eyebrow, copy, actions = '') => `<div class="admin-heading"><div><div class="admin-eyebrow">${eyebrow}</div><h1>${esc(title)}</h1><p>${esc(copy)}</p></div><div class="admin-actions">${actions}</div></div>`;
  const kv = rows => `<dl class="admin-kv">${rows.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  function listPage() {
    const page = route().page;
    const meta = page === 'types' ? ['文档类型', '类型目录', `${state.types.length} 种类型 · ${state.types.filter(item => item.enabled).length} 种启用`, btn('new-type', '登记类型', 'plus', 'class="primary"')] : page === 'admins' ? ['管理员', '访问控制', `${state.admins.length} 位管理员 · Google 身份`, btn('new-admin', '添加管理员', 'plus', 'class="primary"')] : ['审计', '活动记录', '视图包、操作代理与访问管理记录', ''];
    const heads = page === 'types' ? ['文档类型', '当前视图包', '当前操作代理', '主站状态', '最近更新', ''] : page === 'admins' ? ['管理员邮箱', 'Google 身份', '添加人', '添加时间', ''] : ['时间', '操作者', '动作', '目标', '结果'];
    shell(heading(...meta) + `<div class="admin-filters"><label class="admin-search">${ico('search')}<input id="admin-search" type="search" placeholder="搜索${page === 'types' ? '类型、视图包或操作代理' : '记录'}" value="${esc(query)}"></label>${page === 'types' ? '<select id="admin-filter"><option value="">所有状态</option><option value="on">已启用</option><option value="off">已停用</option></select>' : ''}<span class="admin-result" id="admin-result"></span></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr>${heads.map(value => `<th>${value}</th>`).join('')}</tr></thead><tbody id="admin-rows"></tbody></table></div><div id="admin-footer"></div>`);
    if (page === 'types') document.getElementById('admin-filter').value = filter;
    rows();
  }
  function rows() {
    const page = route().page;
    let items = state[page].filter(item => JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));
    if (page === 'types' && filter) items = items.filter(item => item.enabled === (filter === 'on'));
    let html = '';
    if (page === 'types') html = items.map(item => { const bundle = activeBundle(item); const card = activeTypeCardBundle(item); const operator = activeOperator(item); return `<tr><td><a class="admin-cell-name" href="${href('types', item.id)}"><span class="type-symbol ${item.id}">${ico(card?.glyph || 'shapes')}</span><span><strong>${esc(publicName(item))}</strong>${sub(item.id)}</span></a></td><td>${bundle ? `${code(short(bundle.id))}${sub(`${item.bundles.length} 个候选项`)}` : tone('未配置', 'warn')}</td><td>${operator ? `<strong class="admin-table-strong">${esc(operator.name)}</strong>${sub(`${item.operators.length} 个候选项 · ${new URL(operator.url).host}`)}` : tone('未配置', 'warn')}</td><td>${tone(item.enabled ? '已启用' : '未完成', item.enabled ? 'good' : 'warn')}</td><td>${item.updated}</td><td><a href="${href('types', item.id)}">管理 ${ico('arrow-up-right')}</a></td></tr>`; }).join('');
    if (page === 'admins') html = items.map(item => `<tr><td><strong>${item.email}</strong>${item.email === me ? '<span class="admin-tag">你</span>' : ''}</td><td>${tone(item.bound ? '已绑定' : '待登录', item.bound ? 'good' : '')}</td><td>${item.by}</td><td>${item.date}</td><td>${iconBtn('delete-admin', '删除', 'trash-2', `data-id="${item.email}" ${item.email === me ? 'disabled' : ''}`)}</td></tr>`).join('');
    if (page === 'audit') html = items.map((item, index) => `<tr><td>${item[0]}</td><td>${item[1]}</td><td><button class="ghost small" data-action="audit-detail" data-id="${index}">${item[2]}</button></td><td>${code(item[3])}</td><td>${tone('成功', 'good')}</td></tr>`).join('');
    document.getElementById('admin-rows').innerHTML = html || '<tr><td colspan="6"><div class="admin-empty">没有匹配的记录</div></td></tr>';
    document.getElementById('admin-result').textContent = `${items.length} 条记录`;
    document.getElementById('admin-footer').innerHTML = `<div class="admin-table-footer"><span>${items.length} 条记录</span><span>全部已加载</span></div>`;
    drawIcons();
  }
  function bundleSummary(record) { return `<div class="bundle-summary"><span class="bundle-mark">${ico('package-open')}</span><div class="grow"><div class="row"><strong>${esc(record.name)}</strong>${record.current ? '<span class="admin-tag current">当前</span>' : ''}</div><p class="candidate-description">${esc(record.description) || '未填写描述'}</p><div class="admin-mono">${record.id}</div><div class="bundle-meta"><span>${ico('file-archive')}${record.size}</span><span>${ico('calendar')}${record.date}</span><span>${ico('file-code')}${record.entry}</span><span>${ico('braces')}contract ${record.contracts.join(', ')}</span></div></div></div>`; }
  function typeCardBundleSummary(record) { return `<div class="bundle-summary"><span class="type-card-bundle-mark">${ico('layout-template')}</span><div class="grow"><div class="row"><strong>${esc(record.name)}</strong>${record.current ? '<span class="admin-tag current">当前</span>' : ''}</div><p class="candidate-description">${esc(record.description) || '未填写描述'}</p><div class="admin-mono">${record.id}</div><div class="bundle-meta"><span>${ico('file-archive')}${record.size}</span><span>${ico('languages')}${Object.keys(record.locales).join(' / ')}</span><span>${ico('image')}图标 + sample thumbnail</span></div></div></div>`; }
  function typeCardPreview(record) { const locales = Object.entries(record.locales); const uiLocale = document.documentElement.lang.toLowerCase(); const initialLocale = locales.find(([locale]) => locale.toLowerCase() === uiLocale)?.[0] || locales.find(([locale]) => uiLocale.startsWith(`${locale.toLowerCase()}-`))?.[0] || 'en'; const initialCopy = record.locales[initialLocale]; return `<div class="type-card-preview-tool" data-preview-locale="${initialLocale}"><div class="type-card-preview-toolbar"><span>卡片预览</span><div class="type-card-locales" role="group" aria-label="预览语言">${locales.map(([locale]) => `<button type="button" class="${locale === initialLocale ? 'active' : ''}" data-action="card-preview-locale" data-locale="${locale}" aria-pressed="${locale === initialLocale}">${locale.toUpperCase()}</button>`).join('')}</div></div><div class="type-card-preview"><div class="type-card-thumbnail" role="img" aria-label="${esc(initialCopy.name)} sample thumbnail"><span>${ico(record.glyph)}</span><small>${esc(record.thumbnail)}</small></div><div class="type-card-copy"><span class="type-card-icon">${ico(record.glyph)}</span>${locales.map(([locale, copy]) => `<div class="type-card-locale" data-locale-panel="${locale}" data-locale-name="${esc(copy.name)}" ${locale === initialLocale ? '' : 'hidden'}><strong>${esc(copy.name)}</strong><p>${esc(copy.description)}</p></div>`).join('')}</div></div></div>`; }
  function snapshotContractSummary(record, latest = false) { return `<div class="contract-summary"><div class="row"><span class="contract-idx">${record.idx}</span><div class="grow"><div class="row"><strong>Snapshot contract ${record.idx}</strong>${latest ? '<span class="admin-tag current">最新版 · 唯一可写</span>' : '<span class="admin-tag">历史只读</span>'}</div><div class="admin-mono">${esc(record.contentType)}</div></div></div><div class="bundle-meta"><span>${ico('fingerprint')}${esc(record.schemaHash)}</span><span>${ico('calendar')}${record.date}</span><span>${ico('braces')}SValue JSON Schema</span></div></div>`; }
  function operatorSummary(record) { return `<div class="bundle-summary"><span class="operator-mark">${ico('bot')}</span><div class="grow"><div class="row"><strong>${esc(record.name)}</strong>${record.current ? '<span class="admin-tag current">当前</span>' : ''}</div><p class="candidate-description">${esc(record.description) || '未填写描述'}</p><div class="admin-mono">${esc(record.id)}</div><div class="bundle-meta"><span>${ico('link')}${esc(record.url)}</span><span>${ico('calendar')}${record.date}</span><span>${ico('shield-check')}验证通过</span><span>${ico('braces')}contract ${record.contracts.join(', ')}</span></div></div></div>`; }
  function detailPage(item) {
    const bundle = activeBundle(item);
    const card = activeTypeCardBundle(item);
    const operator = activeOperator(item);
    const latestContract = item.snapshotContracts.at(-1) || null;
    const tabs = `<div class="admin-tabs">${[['config', '基本信息'], ['contracts', `Snapshot 契约 ${item.snapshotContracts.length}`], ['cards', `类型卡片包 ${item.typeCardBundles.length}`], ['bundles', `界面包 ${item.bundles.length}`], ['operators', `处理服务 ${item.operators.length}`], ['changes', '变更记录']].map(([id, label]) => `<button class="admin-tab ${tab === id ? 'active' : ''}" data-action="tab" data-id="${id}">${label}</button>`).join('')}</div>`;
    let body = '';
    if (tab === 'config') body = `<section class="admin-section"><div class="admin-section-head"><h2>基本信息</h2>${btn('edit-info', '编辑内部名称', 'pencil')}</div>${kv([['内部名称', esc(item.name)], ['类型标识', code(item.id)]])}</section><section class="admin-section"><div class="admin-section-head"><h2>当前类型卡片</h2>${btn('tab', '管理类型卡片包', 'list', 'data-id="cards"')}</div>${card ? `<div class="admin-config-band">${typeCardBundleSummary(card)}${typeCardPreview(card)}</div>` : '<div class="admin-empty compact">尚未选择类型卡片包</div>'}</section><section class="admin-section"><div class="admin-section-head"><h2>当前界面包</h2>${btn('tab', '管理界面包', 'list', 'data-id="bundles"')}</div>${bundle ? `<div class="admin-config-band">${bundleSummary(bundle)}</div>` : '<div class="admin-empty compact">尚未选择视图包</div>'}</section><section class="admin-section"><div class="admin-section-head"><h2>当前处理服务</h2>${btn('tab', '全部服务', 'list', 'data-id="operators"')}</div>${operator ? `<div class="admin-config-band">${operatorSummary(operator)}</div>` : '<div class="admin-empty compact">尚未配置处理服务</div>'}</section>`;
    if (tab === 'cards') body = `<section class="admin-section"><div class="admin-section-head"><div><h2>类型卡片包候选项</h2><p>每个不可变版本包含多语言名称与描述、图标资源和 sample thumbnail。</p></div>${btn('upload-type-card-bundle', '上传候选项', 'upload')}</div>${item.typeCardBundles.length ? `<div class="bundle-history">${item.typeCardBundles.map(record => `<article class="bundle-row ${record.current ? 'active' : ''}"><div>${typeCardBundleSummary(record)}${typeCardPreview(record)}</div><div class="candidate-actions">${record.current ? tone('正在使用', 'good') : btn('activate-type-card-bundle', '设为当前', 'check', `data-id="${record.id}"`)}${iconBtn('edit-candidate', '编辑名称与描述', 'pencil', `data-kind="card" data-id="${record.id}"`)}${iconBtn('delete-type-card-bundle', record.current ? '不能删除当前类型卡片包' : '删除类型卡片包', 'trash-2', `data-id="${record.id}" ${record.current ? 'disabled' : ''}`)}</div></article>`).join('')}</div>` : `<div class="admin-placeholder">${ico('layout-template')}<div><strong>还没有类型卡片包候选项</strong><p>上传包含 manifest、多语言文案、图标和 sample thumbnail 的 ZIP 文件。</p></div></div>`}</section>`;
    if (tab === 'contracts') body = `<section class="admin-section"><div class="admin-section-head"><div><h2>Snapshot 契约</h2><p>revision 单调递增且不可删除；只有最新版可用于创建新 snapshot。</p></div>${btn('add-snapshot-contract', '添加新 revision', 'plus', item.enabled ? 'disabled title="请先停用文档类型"' : '')}</div>${item.snapshotContracts.length ? `<div class="contract-history">${[...item.snapshotContracts].reverse().map((record, index) => `<article class="contract-row ${index === 0 ? 'active' : ''}">${snapshotContractSummary(record, index === 0)}<details><summary>查看 schema</summary><pre>${esc(JSON.stringify(record.schema, null, 2))}</pre></details></article>`).join('')}</div>` : `<div class="admin-placeholder">${ico('braces')}<div><strong>还没有 Snapshot 契约</strong><p>添加首个 content type 与 SValue JSON Schema 后，才能启用此类型。</p></div></div>`}</section>`;
    if (tab === 'bundles') body = `<section class="admin-section"><div class="admin-section-head"><div><h2>视图包候选项</h2><p>可上传多个；同时只能有一个当前项。</p></div>${btn('upload-bundle', '上传候选项', 'upload')}</div>${item.bundles.length ? `<div class="bundle-history">${item.bundles.map(record => `<article class="bundle-row ${record.current ? 'active' : ''}">${bundleSummary(record)}<div class="candidate-actions">${record.current ? tone('正在使用', 'good') : btn('activate-bundle', '设为当前', 'check', `data-id="${record.id}"`)}${iconBtn('edit-candidate', '编辑名称与描述', 'pencil', `data-kind="bundle" data-id="${record.id}"`)}${iconBtn('delete-bundle', record.current ? '不能删除当前视图包' : '删除视图包', 'trash-2', `data-id="${record.id}" ${record.current ? 'disabled' : ''}`)}</div></article>`).join('')}</div>` : `<div class="admin-placeholder">${ico('package-open')}<div><strong>还没有视图包候选项</strong><p>上传并验证后，再选择一个当前包。</p></div></div>`}</section>`;
    if (tab === 'operators') body = `<section class="admin-section"><div class="admin-section-head"><div><h2>操作代理候选项</h2><p>可配置多个；同时只能有一个当前项。</p></div>${btn('add-operator', '添加候选项', 'plus')}</div>${item.operators.length ? `<div class="bundle-history">${item.operators.map(record => `<article class="bundle-row ${record.current ? 'active' : ''}">${operatorSummary(record)}<div class="candidate-actions">${record.current ? tone('正在使用', 'good') : btn('activate-operator', '设为当前', 'check', `data-id="${record.id}"`)}${iconBtn('edit-candidate', '编辑名称与描述', 'pencil', `data-kind="operator" data-id="${record.id}"`)}${iconBtn('delete-operator', record.current ? '不能删除当前操作代理' : '删除操作代理', 'trash-2', `data-id="${record.id}" ${record.current ? 'disabled' : ''}`)}</div></article>`).join('')}</div>` : `<div class="admin-placeholder">${ico('bot-off')}<div><strong>还没有操作代理候选项</strong><p>添加并验证后，可将其设为当前项。</p></div></div>`}</section>`;
    if (tab === 'changes') body = `<section class="admin-section"><h2>近期变更</h2>${state.audit.filter(entry => entry[3] === item.id).map(entry => `<div class="admin-release"><div class="row spread"><strong>${entry[2]}</strong>${tone('成功', 'good')}</div>${sub(`${entry[0]} · ${entry[1]}`)}<p>${entry[4]}</p></div>`).join('')}</section>`;
    const missing = [[latestContract, 'Snapshot 契约'], [card, '类型卡片包'], [bundle, '视图包'], [operator, '处理服务']].filter(([value]) => !value).map(([, label]) => label);
    if (latestContract && bundle && !bundle.contracts.includes(latestContract.idx)) missing.push('支持最新版的界面包');
    if (latestContract && operator && !operator.contracts.includes(latestContract.idx)) missing.push('支持最新版的处理服务');
    const toggle = item.enabled ? btn('disable-type', '停用类型', 'pause') : btn('enable-type', '启用类型', 'play', missing.length ? `disabled title="还需配置：${missing.join('、')}"` : '');
    shell(heading(publicName(item), `文档类型 / ${item.id.toUpperCase()}`, publicDescription(item) || '尚未绑定公开展示信息', toggle) + tabs + `<div class="admin-detail-grid"><div>${body}</div><aside class="admin-aside"><h2>主站状态</h2>${tone(item.enabled ? '已启用' : missing.length ? '配置未完成' : '可启用', item.enabled ? 'good' : missing.length ? 'warn' : '')}<p>${item.enabled ? '新建与编辑入口开放' : missing.length ? `还需配置：${missing.join('、')}` : '所有必要配置已就绪'}</p><hr><h2>现有文档</h2><div class="admin-big-number">${item.documents}<span> 件</span></div><h2>配置版本</h2><p>${code(item.etag)}</p><h2>最近更新</h2><p>${item.updated}</p></aside></div>`, publicName(item));
  }
  function render() { const r = route(); const item = state.types.find(item => item.id === r.id); r.page === 'types' && item ? detailPage(item) : listPage(); }
  function editInfo(item) {
    dialog('编辑内部名称', `<div class="admin-notice">${ico('info')}<span>内部名称只供管理员识别。用户看到的名称和描述来自当前类型卡片包。</span></div><div class="admin-fields"><label>内部名称<input name="name" value="${esc(item.name)}" required maxlength="80"></label><label>类型标识<input value="${esc(item.id)}" readonly></label></div>`, '保存', fields => {
      const name = fields.get('name').trim();
      if (!name) return '请填写内部名称';
      item.name = name;
      item.updated = '刚刚';
      log('编辑基本信息', item.id, '更新内部名称');
      toast('基本信息已保存');
    }, { wide: true });
  }
  function dialog(title, body, submit, onSubmit, options = {}) {
    modal.className = options.wide ? 'wide' : '';
    modal.innerHTML = `<form><div class="admin-modal-head"><h2 id="modal-heading">${title}</h2>${iconBtn('close-modal', '关闭', 'x')}</div><div class="admin-modal-body">${body}<p class="admin-form-error"></p></div><div class="admin-modal-foot"><button type="button" data-action="close-modal">取消</button><button type="submit" class="${options.danger ? 'admin-danger' : 'primary'}" ${options.disabled ? 'disabled' : ''}>${submit}</button></div></form>`;
    modal.querySelector('form').onsubmit = event => { event.preventDefault(); const error = onSubmit(new FormData(event.currentTarget)); if (error) { modal.querySelector('.admin-form-error').textContent = error; return; } modal.close(); render(); };
    modal.querySelector('[name="englishDescription"]')?.setAttribute('aria-label', '英文描述');
    modal.querySelector('[name="chineseDescription"]')?.setAttribute('aria-label', '中文描述');
    modal.showModal(); drawIcons();
  }
  const uploadControl = type => `<div class="upload-zone">${ico('file-archive')}<div class="grow"><strong>视图包 ZIP 文件</strong><input name="bundle" type="file" accept=".zip,application/zip"></div>${type ? `<input name="type" type="hidden" value="${type}">` : '<select name="type"><option value="diagram">流程图</option><option value="markdown">Markdown</option><option value="docx">Word 文档</option></select>'}${btn('verify-bundle', '上传并验证', 'upload-cloud')}</div><div id="bundle-result"></div>`;
  const typeCardBundleUploadControl = () => `<div class="upload-zone">${ico('layout-template')}<div class="grow"><strong>类型卡片包 ZIP 文件</strong><p>包含 unidocs-type-card.json、多语言文案、图标与 sample thumbnail。</p><input name="typeCardBundle" type="file" accept=".zip,application/zip"></div>${btn('verify-type-card-bundle', '上传并验证', 'upload-cloud')}</div><div id="type-card-bundle-result"></div>`;
  function verifyBundle() {
    const form = modal.querySelector('form'); const file = form.elements.bundle.files[0];
    if (!file || !file.name.toLowerCase().endsWith('.zip')) { modal.querySelector('.admin-form-error').textContent = '请选择 ZIP 文件'; return; }
    const type = form.elements.type.value; const names = { markdown: 'Markdown', psd: 'PSD', docx: 'Word 文档', diagram: '流程图' }; const hash = [...file.name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 17).toString(16).padStart(8, '0');
    context.bundle = bundle(`vb_${hash}a91e4c7d`, type, '刚刚', file.size ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : '318 KB');
    context.bundle.contracts = [context.item.snapshotContracts.at(-1)?.idx || 1];
    context.bundle.name = form.elements.candidateName.value.trim();
    context.bundle.description = form.elements.candidateDescription.value.trim();
    document.getElementById('bundle-result').innerHTML = `<div class="manifest-panel"><div class="row spread"><strong>${ico('circle-check')} 视图包验证通过</strong>${tone(context.bundle.size, 'good')}</div>${kv([['文档类型', `<strong>${names[type] || context.item?.name || type}</strong>${sub(type)}`], ['视图包 ID', code(context.bundle.id)], ['Manifest 协议', code(context.bundle.protocol)], ['入口', code(context.bundle.entry)], ['位置类型', context.bundle.locations.map(value => `<span class="admin-tag">${value}</span>`).join('')]])}</div>`;
    modal.querySelector('button[type=submit]').disabled = false; modal.querySelector('.admin-form-error').textContent = ''; drawIcons();
  }
  function verifyTypeCardBundle() {
    const form = modal.querySelector('form'); const file = form.elements.typeCardBundle.files[0];
    if (!file || !file.name.toLowerCase().endsWith('.zip')) { modal.querySelector('.admin-form-error').textContent = '请选择类型卡片包 ZIP 文件'; return; }
    const hash = [...file.name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 23).toString(16).padStart(8, '0');
    const glyphs = { markdown: 'file-text', psd: 'layers', docx: 'file-type-2', diagram: 'workflow' };
    const cardNames = { markdown: ['Markdown', 'Text, notes and structured writing', 'Markdown', '文本、笔记与结构化写作'], psd: ['PSD', 'Layers, canvases and visual creation', 'PSD', '图层、画布与视觉创作'], docx: ['Word document', 'Formatted documents and file exchange', 'Word 文档', '排版文档与格式交换'], diagram: ['Flowchart', 'Flows, relationships and architecture', '流程图', '流程、关系与架构'] };
    const names = cardNames[context.item.id] || [context.item.name, 'Create and collaborate on a new document.', context.item.name, '创建并协作编辑新文档。'];
    context.typeCardBundle = typeCardBundle(`tb_${hash}c318a6e2`, '刚刚', file.size ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : '132 KB', glyphs[context.item.id] || 'shapes', { en: { name: names[0], description: names[1] }, zh: { name: names[2], description: names[3] } });
    context.typeCardBundle.name = form.elements.candidateName.value.trim();
    context.typeCardBundle.description = form.elements.candidateDescription.value.trim();
    document.getElementById('type-card-bundle-result').innerHTML = `<div class="manifest-panel"><div class="row spread"><strong>${ico('circle-check')} 类型卡片包验证通过</strong>${tone(context.typeCardBundle.size, 'good')}</div>${kv([['类型卡片包 ID', code(context.typeCardBundle.id)], ['Manifest 协议', code(context.typeCardBundle.protocol)], ['可用语言', Object.keys(context.typeCardBundle.locales).map(value => `<span class="admin-tag">${value}</span>`).join('')], ['图标资源', code(context.typeCardBundle.icon.path)], ['样例缩略图', code(context.typeCardBundle.thumbnail)]])}${typeCardPreview(context.typeCardBundle)}</div>`;
    modal.querySelector('button[type=submit]').disabled = false; modal.querySelector('.admin-form-error').textContent = ''; drawIcons();
  }
  function verifyOperator() {
    let url; try { url = new URL(modal.querySelector('[name=url]').value); } catch { modal.querySelector('.admin-form-error').textContent = '请输入有效的 HTTPS URL'; return; }
    const fixture = operators[url.href]; const type = context.item?.id || context.bundle?.type;
    if (!fixture) { modal.querySelector('.admin-form-error').textContent = '沙盒没有此操作代理的发现数据'; return; }
    if (type && !fixture[2].includes(type)) { modal.querySelector('.admin-form-error').textContent = `此操作代理不支持 ${type}`; return; }
    context.operator = operator(fixture[0], fixture[1], url.href, '刚刚');
    context.operator.contracts = [context.item?.snapshotContracts.at(-1)?.idx || 1];
    const nameInput = modal.querySelector('[name=candidateName]'); const descriptionInput = modal.querySelector('[name=candidateDescription]');
    if (nameInput) nameInput.value ||= fixture[0];
    if (descriptionInput) descriptionInput.value ||= `已验证的 ${fixture[0]} 候选服务`;
    context.operator.name = nameInput?.value.trim() || fixture[0];
    context.operator.description = descriptionInput?.value.trim() || '';
    document.getElementById('operator-result').innerHTML = `<div class="manifest-panel"><div class="row spread"><strong>${fixture[0]}</strong>${tone('验证通过', 'good')}</div><ul class="admin-checks"><li class="passed">${ico('circle-check')}unidocs-operator/v1</li><li class="passed">${ico('circle-check')}Webhook 验签通过</li><li class="passed">${ico('circle-check')}平台服务身份可用</li></ul></div>`;
    modal.querySelector('button[type=submit]').disabled = false; modal.querySelector('.admin-form-error').textContent = ''; drawIcons();
  }
  function newType() {
    dialog('登记文档类型', `<div class="admin-notice">${ico('info')}<span>先创建停用的类型草稿。类型卡片包、视图包和处理服务都可以稍后配置。</span></div><div class="admin-fields"><label>内部名称<input name="name" required maxlength="80" autofocus placeholder="例如 Spreadsheet"></label></div>`, '创建类型', fields => {
      const name = fields.get('name').trim();
      if (!name) return '请填写英文名称';
      const baseId = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document-type';
      let id = baseId; let suffix = 2;
      while (state.types.some(item => item.id === id)) id = `${baseId}-${suffix++}`;
      state.types.push({ id, name, text: '', enabled: false, documents: 0, updated: '刚刚', etag: 'cfg-01', operators: [], bundles: [], typeCardBundles: [], snapshotContracts: [] });
      log('登记文档类型', id, '已创建待配置草稿');
      location.hash = href('types', id);
      toast('类型草稿已创建');
    });
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]'); if (!target || target.disabled) return; const action = target.dataset.action; const item = state.types.find(item => item.id === route().id);
    if (action === 'card-preview-locale') { const previewTool = target.closest('.type-card-preview-tool'); const locale = target.dataset.locale; previewTool.dataset.previewLocale = locale; previewTool.querySelectorAll('[data-action="card-preview-locale"]').forEach(button => { const active = button.dataset.locale === locale; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); }); previewTool.querySelectorAll('[data-locale-panel]').forEach(panel => { panel.hidden = panel.dataset.localePanel !== locale; }); const copy = previewTool.querySelector(`[data-locale-panel="${locale}"]`); previewTool.querySelector('.type-card-thumbnail').setAttribute('aria-label', `${copy.dataset.localeName} sample thumbnail`); return; }
    if (action === 'close-modal') return modal.close();
    if (action === 'edit-info' && item) return editInfo(item);
    if (action === 'tab') { tab = target.dataset.id; return render(); }
    if (action === 'new-type') return newType();
    if (action === 'verify-bundle') return verifyBundle();
    if (action === 'verify-type-card-bundle') return verifyTypeCardBundle();
    if (action === 'verify-operator') return verifyOperator();
    if (action === 'add-snapshot-contract') { const latest = item.snapshotContracts.at(-1); const nextIdx = (latest?.idx || 0) + 1; const suggestedType = latest ? latest.contentType.replace(/;v=\d+$/, `;v=${nextIdx}`) : `application/vnd.unidocs.${item.id}.snapshot+value;v=1`; const sampleSchema = { $schema: 'https://schemas.unidocs.dev/svalue/v1', type: 'object', additionalProperties: true }; dialog(`添加 Snapshot contract ${nextIdx}`, `<div class="admin-notice">${ico('info')}<span>添加后立即成为唯一可写 revision。历史 revision 保留且不可删除。</span></div><div class="admin-fields"><label>Content type<input name="contentType" required value="${esc(suggestedType)}"></label><label>SValue JSON Schema<textarea name="schema" rows="12" class="admin-code-input" spellcheck="false">${esc(JSON.stringify(sampleSchema, null, 2))}</textarea></label><label>变更原因<input name="reason" required></label></div>`, '添加 revision', fields => { let schema; try { schema = JSON.parse(fields.get('schema')); } catch { return 'Schema 必须是有效 JSON'; } if (!schema || Array.isArray(schema) || schema.$schema !== 'https://schemas.unidocs.dev/svalue/v1') return 'Schema 必须使用 SValue schema dialect'; const contentType = fields.get('contentType').trim(); if (!contentType) return '请填写 content type'; if (item.snapshotContracts.at(-1)?.idx !== latest?.idx) return 'Snapshot contract 已更新，请重试'; const canonical = JSON.stringify(schema); const digest = [...canonical].reduce((sum, char) => (sum * 33 + char.charCodeAt(0)) >>> 0, 5381).toString(16).padStart(8, '0'); item.snapshotContracts.push(snapshotContract(nextIdx, contentType, '刚刚', `sha256:${digest}…${digest.slice(0, 4)}`, schema)); item.updated = '刚刚'; tab = 'contracts'; log('添加 Snapshot contract', item.id, `${nextIdx} · ${fields.get('reason')}`); toast(`Snapshot contract ${nextIdx} 已添加`); }, { wide: true }); return; }
    if (action === 'edit-candidate') { const records = target.dataset.kind === 'card' ? item.typeCardBundles : target.dataset.kind === 'bundle' ? item.bundles : item.operators; const record = records.find(candidate => candidate.id === target.dataset.id); dialog('编辑候选项信息', `<div class="admin-notice">${ico('info')}<span>仅修改管理后台中的标识，不改变资源内容、服务发现信息或当前绑定。</span></div><div class="admin-fields"><label>名称<input name="name" required maxlength="80" value="${esc(record.name)}"></label><label>描述<textarea name="description" rows="3" maxlength="300">${esc(record.description)}</textarea></label></div>`, '保存', fields => { const name = fields.get('name').trim(); if (!name) return '请填写名称'; record.name = name; record.description = fields.get('description').trim(); item.updated = '刚刚'; log('编辑候选项信息', item.id, `${target.dataset.kind}:${record.id}`); toast('候选项信息已保存'); }); return; }
    if (action === 'upload-bundle') { dialog('上传视图包候选项', `<div class="admin-notice">${ico('info')}<span>名称与描述只供管理员识别，可随时修改。</span></div><div class="admin-fields"><label>候选项名称<input name="candidateName" required value="${esc(`${item.name} 界面包`)}"></label><label>候选项描述<textarea name="candidateDescription" rows="2"></textarea></label></div>${uploadControl(item.id)}`, '完成', () => { if (!context.bundle) return '请先验证视图包'; if (item.bundles.some(record => record.id === context.bundle.id)) return '此视图包已在候选列表中'; item.bundles.unshift(context.bundle); tab = 'bundles'; log('上传视图包候选项', item.id, context.bundle.id); toast('视图包候选项已添加'); }, { disabled: true }); context = { mode: 'upload', item, bundle: null }; return; }
    if (action === 'upload-type-card-bundle') { dialog('上传类型卡片包候选项', `<div class="admin-notice">${ico('info')}<span>名称与描述只供管理员识别，不进入内容寻址 manifest。</span></div><div class="admin-fields"><label>候选项名称<input name="candidateName" required value="${esc(`${item.name} 类型卡片`)}"></label><label>候选项描述<textarea name="candidateDescription" rows="2"></textarea></label></div>${typeCardBundleUploadControl()}`, '完成', () => { if (!context.typeCardBundle) return '请先验证类型卡片包'; if (item.typeCardBundles.some(record => record.id === context.typeCardBundle.id)) return '此类型卡片包已在候选列表中'; item.typeCardBundles.unshift(context.typeCardBundle); tab = 'cards'; item.updated = '刚刚'; log('上传类型卡片包候选项', item.id, context.typeCardBundle.id); toast('类型卡片包候选项已添加'); }, { wide: true, disabled: true }); context = { item, typeCardBundle: null }; return; }
    if (action === 'add-operator') { dialog('添加操作代理候选项', `<div class="admin-notice">${ico('info')}<span>验证服务后，以单独的 Admin 名称与描述保存候选项。</span></div><div class="admin-fields"><label>候选项名称<input name="candidateName" maxlength="80" placeholder="验证后自动填入"></label><label>候选项描述<textarea name="candidateDescription" rows="2" maxlength="300"></textarea></label><label>操作代理基础地址<input name="url" type="url" list="operator-options" placeholder="https://operator.example.com/"></label><datalist id="operator-options">${Object.keys(operators).map(url => `<option value="${url}">`).join('')}</datalist><div>${btn('verify-operator', '验证操作代理', 'shield-check')}</div></div><div id="operator-result"></div>`, '添加候选项', () => { if (!context.operator) return '请先验证操作代理'; if (item.operators.some(record => record.id === context.operator.id)) return '此操作代理已在候选列表中'; if (!activeOperator(item)) context.operator.current = true; item.operators.unshift(context.operator); item.updated = '刚刚'; log('添加操作代理候选项', item.id, context.operator.id); toast('操作代理候选项已添加'); }, { disabled: true }); context = { item, operator: null }; return; }
    if (action === 'activate-bundle') { const next = item.bundles.find(bundle => bundle.id === target.dataset.id); dialog('切换视图包', `${bundleSummary(next)}<div class="admin-notice">${ico('info')}<span>只影响之后新打开的视图，当前会话不会热替换。</span></div><div class="admin-fields"><label>变更原因<input name="reason" required></label></div>`, '确认切换', form => { const current = activeBundle(item); if (current) current.current = false; next.current = true; item.updated = '刚刚'; log('切换视图包', item.id, form.get('reason')); toast('视图包已切换'); }); return; }
    if (action === 'activate-type-card-bundle') { const next = item.typeCardBundles.find(record => record.id === target.dataset.id); dialog('切换类型卡片包', `${typeCardBundleSummary(next)}${typeCardPreview(next)}<div class="admin-fields"><label>变更原因<input name="reason" required></label></div>`, '确认切换', form => { const current = activeTypeCardBundle(item); if (current) current.current = false; next.current = true; item.updated = '刚刚'; log('切换类型卡片包', item.id, form.get('reason')); toast('类型卡片包已切换'); }, { wide: true }); return; }
    if (action === 'activate-operator') { const next = item.operators.find(operator => operator.id === target.dataset.id); dialog('切换操作代理', `${operatorSummary(next)}<div class="admin-notice">${ico('info')}<span>之后的 document.created 事件与新消息将发送给此操作代理。</span></div><div class="admin-fields"><label>变更原因<input name="reason" required></label></div>`, '确认切换', form => { const current = activeOperator(item); if (current) current.current = false; next.current = true; item.updated = '刚刚'; log('切换操作代理', item.id, form.get('reason')); toast('操作代理已切换'); }); return; }
    if (action === 'delete-bundle') { const candidate = item.bundles.find(bundle => bundle.id === target.dataset.id); if (!candidate || candidate.current) return; dialog('删除视图包候选项', `${bundleSummary(candidate)}<div class="admin-notice">${ico('trash-2')}<span>仅从此类型的候选列表移除，不影响当前项。</span></div>`, '删除候选项', () => { item.bundles = item.bundles.filter(bundle => bundle.id !== candidate.id); log('删除视图包候选项', item.id, candidate.id); toast('视图包候选项已删除'); }, { danger: true }); return; }
    if (action === 'delete-type-card-bundle') { const candidate = item.typeCardBundles.find(record => record.id === target.dataset.id); if (!candidate || candidate.current) return; dialog('删除类型卡片包候选项', `${typeCardBundleSummary(candidate)}<div class="admin-notice">${ico('trash-2')}<span>仅从此类型的候选列表移除，不影响当前项。</span></div>`, '删除候选项', () => { item.typeCardBundles = item.typeCardBundles.filter(record => record.id !== candidate.id); log('删除类型卡片包候选项', item.id, candidate.id); toast('类型卡片包候选项已删除'); }, { danger: true }); return; }
    if (action === 'delete-operator') { const candidate = item.operators.find(operator => operator.id === target.dataset.id); if (!candidate || candidate.current) return; dialog('删除操作代理候选项', `${operatorSummary(candidate)}<div class="admin-notice">${ico('trash-2')}<span>仅移除此候选项，不影响当前操作代理。</span></div>`, '删除候选项', () => { item.operators = item.operators.filter(operator => operator.id !== candidate.id); log('删除操作代理候选项', item.id, candidate.id); toast('操作代理候选项已删除'); }, { danger: true }); return; }
    if (action === 'enable-type' || action === 'disable-type') { const enabling = action === 'enable-type'; dialog(enabling ? '启用文档类型' : '停用文档类型', `<div class="admin-notice">${ico('info')}<span>主站将${enabling ? '开放' : '关闭'}新建与编辑入口，现有文档不会删除。</span></div><div class="admin-fields"><label>变更原因<input name="reason" required></label></div>`, enabling ? '确认启用' : '确认停用', form => { item.enabled = enabling; item.updated = '刚刚'; log(enabling ? '启用类型' : '停用类型', item.id, form.get('reason')); toast(`文档类型已${enabling ? '启用' : '停用'}`); }, { danger: !enabling }); return; }
    if (action === 'new-admin') { dialog('添加管理员', '<div class="admin-fields"><label>Google 账号邮箱<input name="email" type="email" required></label></div>', '添加', form => { const email = form.get('email').trim(); if (state.admins.some(item => item.email === email)) return '此邮箱已存在'; state.admins.push({ email, bound: false, by: me, date: new Date().toISOString().slice(0, 10) }); toast('管理员已添加'); }); return; }
    if (action === 'delete-admin') { const email = target.dataset.id; dialog('删除管理员', `<p>${email}</p>`, '删除', () => { state.admins = state.admins.filter(item => item.email !== email); toast('管理员已删除'); }, { danger: true }); return; }
    if (action === 'audit-detail') { const entry = state.audit[target.dataset.id]; dialog('变更记录', kv([['动作', entry[2]], ['目标', code(entry[3])], ['操作者', entry[1]], ['时间', entry[0]], ['详情', entry[4]]]), '完成', () => {}); return; }
    if (action === 'navigation') { nav.innerHTML = `<div class="row spread"><strong>管理工作空间</strong>${iconBtn('close-nav', '关闭', 'x')}</div><nav>${navigation()}</nav>`; nav.showModal(); drawIcons(); return; }
    if (action === 'close-nav') return nav.close();
  });
  document.addEventListener('input', event => { if (event.target.id === 'admin-search') { query = event.target.value; rows(); } if (event.target.name === 'url' && context) { context.operator = null; const result = document.getElementById('operator-result'); if (result) result.innerHTML = ''; modal.querySelector('button[type=submit]').disabled = true; } });
  document.addEventListener('change', event => { if (event.target.id === 'admin-filter') { filter = event.target.value; rows(); } if (event.target.name === 'bundle' && context) { context.bundle = null; document.getElementById('bundle-result').innerHTML = ''; modal.querySelector('button[type=submit]').disabled = true; } if (event.target.name === 'typeCardBundle' && context) { context.typeCardBundle = null; document.getElementById('type-card-bundle-result').innerHTML = ''; modal.querySelector('button[type=submit]').disabled = true; } });
  modal.addEventListener('close', () => { context = null; modal.className = ''; });
  window.addEventListener('hashchange', () => { tab = 'config'; query = ''; filter = ''; if (modal.open) modal.close(); render(); });
  render();
})();