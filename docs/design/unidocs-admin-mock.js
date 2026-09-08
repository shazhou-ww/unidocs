(() => {
  'use strict';
  const app = document.getElementById('admin-app');
  const modal = document.getElementById('admin-modal');
  const navDialog = document.getElementById('admin-nav');
  const selfEmail = 'lee@example.com';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const icons = () => window.lucide?.createIcons();
  const button = (action, label, glyph, extra = '') => `<button type="button" data-action="${action}" ${extra}>${icon(glyph)}${label}</button>`;
  const iconButton = (action, label, glyph, extra = '') => `<button type="button" class="icon ghost" data-action="${action}" title="${label}" aria-label="${label}" ${extra}>${icon(glyph)}</button>`;
  const status = (label, tone = '') => `<span class="admin-status ${tone}">${escapeHtml(label)}</span>`;
  const secondary = value => `<span class="admin-secondary">${escapeHtml(value)}</span>`;
  const mono = value => `<span class="admin-mono">${escapeHtml(value)}</span>`;
  const catalog = {
    markdown: { id: 'markdown', name: 'Markdown', description: '文本、笔记与结构化写作', icon: 'file-text', formats: '.md, .markdown', serviceId: 'markdown-cf' },
    psd: { id: 'psd', name: 'PSD', description: '图层、画布与视觉创作', icon: 'layers', formats: '.psd', serviceId: 'psd-cf' },
    docx: { id: 'docx', name: 'Word 文档', description: '排版文档与格式交换', icon: 'file-type-2', formats: '.docx', serviceId: 'docx-cf' },
    diagram: { id: 'diagram', name: '流程图', description: '流程、关系与架构', icon: 'workflow', formats: '.diagram', serviceId: 'diagram-cf' }
  };
  const fixtures = {
    'https://markdown.example.com/': catalog.markdown,
    'https://markdown-next.example.com/': catalog.markdown,
    'https://psd.example.com/': catalog.psd,
    'https://docx.example.com/': catalog.docx,
    'https://types.example.com/diagram/': catalog.diagram,
    'https://markdown-other.example.com/': { ...catalog.markdown, serviceId: 'other-storage' }
  };
  const state = {
    signedIn: true,
    types: [
      { ...catalog.markdown, baseUrl: 'https://markdown.example.com/', enabled: true, checkedAt: '今天 10:32', documents: 128, configRevision: 1 },
      { ...catalog.psd, baseUrl: 'https://psd.example.com/', enabled: true, checkedAt: '今天 10:28', documents: 46, configRevision: 1 },
      { ...catalog.docx, baseUrl: 'https://docx.example.com/', enabled: false, checkedAt: '昨天 17:40', documents: 83, configRevision: 1 }
    ],
    admins: [{ email: selfEmail, added: '2026-09-01', by: '初始化', bound: true }, { email: 'chen@example.com', added: '2026-09-05', by: selfEmail, bound: true }],
    audit: [
      { time: '今天 10:32', action: '验证 URL', target: 'markdown', actor: selfEmail, detail: '类型、服务身份与标准入口匹配。' },
      { time: '今天 10:28', action: '启用类型', target: 'psd', actor: 'chen@example.com', detail: '主站开放创建与编辑入口。' },
      { time: '昨天 17:40', action: '停用类型', target: 'docx', actor: selfEmail, detail: '停止主站新建与编辑；已有作品仍保留。' },
      { time: '09-05 09:16', action: '添加管理员', target: 'chen@example.com', actor: selfEmail, detail: '添加邮箱名单，等待首次 Google 登录绑定。' }
    ]
  };
  const sections = [{ id: 'types', label: '文档类型', icon: 'shapes' }, { id: 'admins', label: '管理员', icon: 'users-round' }, { id: 'audit', label: '审计', icon: 'history' }];
  const route = () => { const params = new URLSearchParams(location.hash.slice(1)); return { section: params.get('view') || 'types', id: params.get('id') || '' }; };
  const href = (section, id = '') => `#view=${section}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
  let search = '';
  let filter = '';
  let activeTab = 'config';
  let toastTimer;
  let modalTrigger;
  let urlContext = null;
  const brand = '<a class="admin-brand" href="#view=types"><img src="logo/04-studio-seal.svg" alt="">UniDocs</a>';
  function toast(message) { const element = document.getElementById('admin-toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 3500); }
  function log(action, target, detail, failed = false) { state.audit.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), action, target, actor: selfEmail, detail, failed }); }
  function navigation() { return sections.map(section => `<a class="admin-nav-item ${route().section === section.id ? 'active' : ''}" href="${href(section.id)}">${icon(section.icon)}${section.label}${section.id === 'types' ? `<span class="nav-count">${String(state.types.length).padStart(2, '0')}</span>` : ''}</a>`).join(''); }
  function shell(content, detailName = '') {
    const section = sections.find(item => item.id === route().section) || sections[0];
    document.title = `UniDocs 运营 · ${detailName || section.label}`;
    app.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar">${brand}<div class="admin-workspace">运营工作空间</div><nav aria-label="主导航">${navigation()}</nav><div class="admin-sidebar-bottom"><div class="row"><span class="admin-avatar">LS</span><div class="grow"><div style="font-size:12px">Lee <span class="admin-tag">管理员</span></div><div class="account-email">${selfEmail}</div></div>${iconButton('logout', '退出登录', 'log-out')}</div></div></aside><main class="admin-main"><header class="admin-topbar"><div class="admin-crumb"><span>运营工作空间</span><span>/</span><a href="${href(section.id)}">${section.label}</a>${detailName ? `<span>/</span><span>${escapeHtml(detailName)}</span>` : ''}</div><div class="row"><span class="admin-environment">${icon('flask-conical')}沙盒</span><button type="button" class="icon ghost admin-menu" data-action="navigation" title="打开导航" aria-label="打开导航">${icon('menu')}</button></div></header><div class="admin-content">${content}</div></main></div>`;
    icons();
  }
  function heading(title, eyebrow, subtitle, actions = '') { return `<div class="admin-heading"><div><div class="admin-eyebrow">${eyebrow}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="admin-actions">${actions}</div></div>`; }
  function kv(entries) { return `<dl class="admin-kv">${entries.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${value}</dd></div>`).join('')}</dl>`; }
  function listing() {
    const section = route().section;
    const config = { types: ['文档类型', 'TYPE DIRECTORY', `${state.types.length} 种文档类型 · ${state.types.filter(item => item.enabled).length} 种主站启用`, '登记类型', 'new-type'], admins: ['管理员', 'ACCESS CONTROL', `${state.admins.length} 位管理员 · Google 身份`, '添加管理员', 'new-admin'], audit: ['审计', 'ACTIVITY LOG', '类型目录与访问管理记录', '', ''] }[section];
    const headers = section === 'types' ? [['文档类型', 'width:23%'], ['Base URL', 'width:34%'], ['主站状态', ''], ['最近验证', ''], ['', 'width:70px']] : section === 'admins' ? [['管理员邮箱', 'width:32%'], ['Google 身份', ''], ['添加人', ''], ['添加时间', ''], ['', 'width:56px']] : [['时间', 'width:14%'], ['操作者', 'width:23%'], ['动作', ''], ['目标', 'width:25%'], ['结果', '']];
    const placeholder = section === 'types' ? '搜索名称、ID 或 URL' : section === 'admins' ? '搜索邮箱' : '搜索动作、目标或操作者';
    shell(heading(config[0], config[1], config[2], `${iconButton('refresh', '刷新列表', 'refresh-cw')}${config[3] ? button(config[4], config[3], 'plus', 'class="primary"') : ''}`) + `<div class="admin-filters"><label class="admin-search">${icon('search')}<input id="admin-search" type="search" aria-label="${placeholder}" placeholder="${placeholder}" value="${escapeHtml(search)}"></label>${section === 'types' ? '<select id="admin-filter" aria-label="按主站状态筛选"><option value="">所有状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select>' : ''}<span class="admin-result" id="admin-result"></span></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr>${headers.map(([name, style]) => `<th style="${style}">${name}</th>`).join('')}</tr></thead><tbody id="admin-rows"></tbody></table></div><div id="admin-footer"></div>`);
    const select = document.getElementById('admin-filter'); if (select) select.value = filter;
    renderRows();
  }
  function renderRows() {
    const section = route().section;
    let items = state[section].filter(item => JSON.stringify(item).toLowerCase().includes(search.toLowerCase()));
    if (section === 'types' && filter) items = items.filter(item => filter === 'enabled' ? item.enabled : !item.enabled);
    let rows;
    if (section === 'types') rows = items.map(item => `<tr><td><a class="admin-cell-name" href="${href('types', item.id)}"><span class="type-symbol ${item.id}">${icon(item.icon)}</span><span><strong>${escapeHtml(item.name)}</strong>${secondary(item.id)}</span></a></td><td>${mono(item.baseUrl)}</td><td>${status(item.enabled ? '已启用' : '已停用', item.enabled ? 'good' : '')}</td><td>${escapeHtml(item.checkedAt)}</td><td><a href="${href('types', item.id)}" aria-label="管理 ${escapeHtml(item.name)}">管理 ${icon('arrow-up-right')}</a></td></tr>`).join('');
    if (section === 'admins') rows = items.map(item => `<tr><td><strong style="font-weight:500">${escapeHtml(item.email)}</strong>${item.email === selfEmail ? '<span class="admin-tag">你</span>' : ''}</td><td>${status(item.bound ? '已绑定' : '尚未登录', item.bound ? 'good' : '')}</td><td>${escapeHtml(item.by)}</td><td>${escapeHtml(item.added)}</td><td>${iconButton('delete-admin', item.email === selfEmail ? '不能删除自己' : `删除 ${escapeHtml(item.email)}`, 'trash-2', `data-id="${escapeHtml(item.email)}" ${item.email === selfEmail ? 'disabled' : ''}`)}</td></tr>`).join('');
    if (section === 'audit') rows = items.map(item => `<tr><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.actor)}</td><td><button type="button" class="ghost small" data-action="audit-detail" data-id="${state.audit.indexOf(item)}">${escapeHtml(item.action)}</button></td><td>${mono(item.target)}</td><td>${status(item.failed ? '未通过' : '成功', item.failed ? 'bad' : 'good')}</td></tr>`).join('');
    document.getElementById('admin-rows').innerHTML = rows || '<tr><td colspan="5"><div class="admin-empty">没有匹配的记录</div></td></tr>';
    document.getElementById('admin-result').textContent = `${items.length} 条记录`;
    document.getElementById('admin-footer').innerHTML = `<div class="admin-table-footer"><span>${items.length} 条记录</span><span>全部已加载</span></div>`;
    icons();
  }
  function typeDetail(item) {
    const tabs = `<div class="admin-tabs" role="tablist" aria-label="类型详情">${[['config', '接入配置'], ['changes', '变更记录']].map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === activeTab}" class="admin-tab ${key === activeTab ? 'active' : ''}" data-action="tab" data-id="${key}">${label}</button>`).join('')}</div>`;
    const content = activeTab === 'config' ? `<section class="admin-section"><div class="row spread"><h2>接入地址</h2>${button('change-url', '更换 URL', 'pencil')}</div>${kv([['Base URL', mono(item.baseUrl)], ['服务 API', mono(new URL('./api/', item.baseUrl).href)], ['编辑器入口', mono(new URL('./editor/', item.baseUrl).href)], ['类型 ID', mono(item.id)], ['名称', escapeHtml(item.name)], ['支持格式', escapeHtml(item.formats)]])}</section>` : `<section class="admin-section"><h2>近期变更</h2>${state.audit.filter(entry => entry.target === item.id).map(entry => `<div class="admin-release"><strong>${escapeHtml(entry.action)}</strong>${secondary(`${entry.time} · ${entry.actor}`)}<p style="margin:12px 0 0;font-size:12px">${escapeHtml(entry.detail)}</p></div>`).join('') || '<div class="admin-empty">暂无变更记录</div>'}</section>`;
    shell(heading(item.name, `TYPE / ${item.id.toUpperCase()}`, item.description, button(item.enabled ? 'disable-type' : 'enable-type', item.enabled ? '停用类型' : '启用类型', item.enabled ? 'pause' : 'play')) + tabs + `<div class="admin-detail-grid"><div role="tabpanel">${content}</div><aside class="admin-aside"><h2>UniDocs 主站</h2>${status(item.enabled ? '已启用' : '已停用', item.enabled ? 'good' : '')}<p>${item.enabled ? '创建、编辑入口已开放' : '创建、编辑入口已关闭'}</p><hr style="border:0;border-top:1px solid var(--line);margin:24px 0"><h2>已有作品</h2><div class="admin-big-number">${item.documents}<span style="font-size:12px;color:var(--muted)"> 件</span></div><h2>最近验证</h2><p>${escapeHtml(item.checkedAt)}</p></aside></div>`, item.name);
  }
  function render() {
    if (!state.signedIn) { app.innerHTML = `<main class="admin-login">${brand}<h1 style="font-size:20px;font-weight:500;margin:0">运营工作空间</h1><p>Google 管理员账号</p>${button('login', '使用 Google 账号登录', 'log-in', 'class="primary"')}</main>`; icons(); return; }
    const current = route();
    if (!sections.some(item => item.id === current.section)) { location.hash = href('types'); return; }
    if (current.section === 'types' && current.id) {
      const item = state.types.find(record => record.id === current.id);
      if (item) typeDetail(item); else shell(heading('找不到此记录', 'NOT FOUND', '', '') + '<a href="#view=types">返回文档类型</a>');
    } else listing();
  }
  function openModal(title, body, submitLabel, onSubmit, danger = false) {
    urlContext = null;
    modalTrigger = { action: document.activeElement?.dataset.action, id: document.activeElement?.dataset.id };
    modal.innerHTML = `<form id="admin-dialog-form"><div class="admin-modal-head"><h2 id="modal-heading">${escapeHtml(title)}</h2>${iconButton('close-modal', '关闭', 'x')}</div><div class="admin-modal-body">${body}<p class="admin-form-error" role="alert"></p></div><div class="admin-modal-foot"><button type="button" data-action="close-modal">取消</button><button type="submit" class="${danger ? 'admin-danger' : 'primary'}">${escapeHtml(submitLabel)}</button></div></form>`;
    modal.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const error = onSubmit(new FormData(event.target));
      if (error) { modal.querySelector('[role=alert]').textContent = error; return; }
      modal.close(); render();
    });
    modal.showModal(); icons();
  }
  function normalizeUrl(value) {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请输入不带凭据、查询参数或 fragment 的 HTTPS Base URL');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  }
  function openUrlDialog(item, mode = 'change') {
    const adding = !item;
    const enabling = mode === 'enable';
    const title = adding ? '登记文档类型' : enabling ? '验证并启用类型' : '更换 Base URL';
    openModal(title, `<div class="admin-fields"><label>Base URL<input name="baseUrl" type="url" required maxlength="2048" list="admin-url-options" value="${escapeHtml(item?.baseUrl || '')}" placeholder="https://types.example.com/diagram/" ${enabling ? 'readonly' : ''}></label><datalist id="admin-url-options">${Object.keys(fixtures).filter(value => !value.includes('other')).map(value => `<option value="${value}"></option>`).join('')}</datalist><div>${button('verify-url', '验证 URL', 'shield-check')}</div></div><div id="admin-url-result" aria-live="polite"></div>${adding ? '<div class="admin-fields" style="margin-top:18px"><label class="checkbox"><input type="checkbox" name="enabled">在主站启用（可创建、编辑）</label></div>' : `${!enabling ? `<div class="admin-notice">${icon('info')}<span>保存后将使用新地址访问此类型。类型和服务身份必须保持一致，不执行数据迁移。</span></div>` : ''}<div class="admin-fields" style="margin-top:18px"><label>变更原因<input name="reason" required maxlength="200"></label></div>`}`, adding ? '登记类型' : enabling ? '确认启用' : '保存 URL', fields => {
      const context = urlContext;
      if (!context?.validation) return '请先验证 URL';
      let baseUrl; try { baseUrl = normalizeUrl(fields.get('baseUrl')); } catch { return 'Base URL 格式无效'; }
      if (baseUrl !== context.validation.baseUrl || Date.now() >= context.validation.expiresAt || item && item.configRevision !== context.expectedRevision) return '配置或验证已变化，请重新验证';
      if (adding) {
        if (state.types.some(record => record.id === context.validation.descriptor.id)) return '该文档类型已登记';
        const next = { ...context.validation.descriptor, baseUrl, enabled: fields.get('enabled') === 'on', documents: 0, checkedAt: '刚刚', configRevision: 1 };
        state.types.push(next); log('登记类型', next.id, `${baseUrl} · ${next.enabled ? '主站已启用' : '主站未启用'}`); location.hash = href('types', next.id); toast('类型已登记');
      } else {
        const previous = item.baseUrl;
        item.baseUrl = baseUrl; item.checkedAt = '刚刚'; item.configRevision += 1;
        if (enabling) item.enabled = true;
        log(enabling ? '启用类型' : '更换 URL', item.id, enabling ? fields.get('reason') : `${previous} → ${baseUrl}；${fields.get('reason')}`);
        toast(enabling ? '主站已开放创建与编辑' : 'Base URL 已更新');
      }
    });
    urlContext = { item, mode, expectedRevision: item?.configRevision, validation: null };
    modal.querySelector('button[type=submit]').disabled = true;
  }
  function verifyUrl() {
    const context = urlContext; if (!context) return;
    context.validation = null;
    modal.querySelector('button[type=submit]').disabled = true;
    modal.querySelector('[role=alert]').textContent = '';
    const result = document.getElementById('admin-url-result');
    let baseUrl;
    try {
      baseUrl = normalizeUrl(modal.querySelector('[name=baseUrl]').value);
      const descriptor = fixtures[baseUrl];
      if (!descriptor) throw new Error('沙盒没有此地址的发现数据');
      if (context.item && descriptor.id !== context.item.id) throw new Error('文档类型不匹配，原 URL 未修改');
      if (context.item && descriptor.serviceId !== context.item.serviceId) throw new Error('服务身份或存储归属不匹配，原 URL 未修改');
      if (!context.item && state.types.some(item => item.id === descriptor.id)) throw new Error('该文档类型已登记');
      if (context.item && context.mode === 'change' && baseUrl === context.item.baseUrl) throw new Error('请输入不同的新地址');
      context.validation = { baseUrl, descriptor, expiresAt: Date.now() + 15 * 60_000 };
      context.expectedRevision = context.item?.configRevision;
      result.innerHTML = `<ul class="admin-checks"><li class="passed">${icon('circle-check')}类型身份与标准入口匹配</li>${context.item ? `<li class="passed">${icon('circle-check')}服务身份与存储归属一致</li>` : ''}</ul>${kv([['文档类型', `${escapeHtml(descriptor.name)} ${secondary(descriptor.id)}`], ['服务 API', mono(new URL('./api/', baseUrl).href)], ['编辑器入口', mono(new URL('./editor/', baseUrl).href)]])}`;
      modal.querySelector('button[type=submit]').disabled = false;
      log('验证 URL', descriptor.id, `${baseUrl} · 沙盒匹配通过`);
    } catch (error) {
      result.innerHTML = `<div class="admin-notice admin-danger">${icon('circle-alert')}<span>${escapeHtml(error.message)}</span></div>`;
      log('验证 URL', context.item?.id || '未登记类型', error.message, true);
    }
    icons();
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]'); if (!target || target.disabled) return;
    const action = target.dataset.action;
    const item = state.types.find(record => record.id === route().id);
    if (action === 'close-modal') { modal.close(); return; }
    if (action === 'navigation') { navDialog.innerHTML = `<div class="row spread" style="margin-bottom:24px"><strong>运营工作空间</strong>${iconButton('close-nav', '关闭导航', 'x')}</div><nav>${navigation()}</nav>${button('logout', '退出登录', 'log-out')}`; navDialog.showModal(); icons(); return; }
    if (action === 'close-nav') { navDialog.close(); return; }
    if (action === 'refresh') { render(); toast('列表已刷新'); return; }
    if (action === 'login') { state.signedIn = true; render(); toast('已进入沙盒工作空间'); return; }
    if (action === 'logout') { if (navDialog.open) navDialog.close(); openModal('退出运营工作空间', `<p>${selfEmail}</p>`, '退出', () => { state.signedIn = false; }); return; }
    if (action === 'tab') { activeTab = target.dataset.id; render(); return; }
    if (action === 'new-type') { openUrlDialog(null); return; }
    if (action === 'change-url' && item) { openUrlDialog(item); return; }
    if (action === 'enable-type' && item) { openUrlDialog(item, 'enable'); return; }
    if (action === 'verify-url') { verifyUrl(); return; }
    if (action === 'disable-type' && item) { openModal('停用文档类型', `<p>${escapeHtml(item.name)}</p><div class="admin-notice">${icon('info')}<span>主站将关闭此类型的新建和编辑入口。${item.documents} 件已有作品保留，仍可按原权限读取和导出。</span></div><div class="admin-fields"><label>变更原因<input name="reason" required maxlength="200"></label></div>`, '确认停用', fields => { item.enabled = false; item.configRevision += 1; log('停用类型', item.id, fields.get('reason')); toast('主站已关闭创建与编辑'); }, true); return; }
    if (action === 'new-admin') {
      openModal('添加管理员', '<div class="admin-fields"><label>Google 账号邮箱<input name="email" type="email" placeholder="name@example.com" required maxlength="254" autofocus></label></div>', '添加管理员', fields => {
        const email = fields.get('email').trim().toLowerCase();
        if (!/^[\x21-\x7e]+$/.test(email)) return '请输入 ASCII 邮箱地址';
        if (state.admins.some(admin => admin.email === email)) return '该邮箱已在管理员名单中';
        state.admins.push({ email, added: new Date().toISOString().slice(0, 10), by: selfEmail, bound: false }); log('添加管理员', email, '添加邮箱名单，等待首次 Google 登录绑定。'); toast('管理员已添加');
      }); return;
    }
    if (action === 'delete-admin') {
      const email = target.dataset.id; if (email === selfEmail) return;
      openModal('删除管理员', `<p>${escapeHtml(email)}</p><div class="admin-notice">${icon('shield-alert')}<span>管理权限将被撤销。普通账号与文档权限不受影响。</span></div>`, '删除管理员', () => { if (state.admins.length <= 1) return '至少保留一名管理员'; state.admins = state.admins.filter(admin => admin.email !== email); log('删除管理员', email, '撤销运营管理资格。'); toast('管理员已删除'); }, true); return;
    }
    if (action === 'audit-detail') { const entry = state.audit[Number(target.dataset.id)]; openModal('变更记录', kv([['动作', escapeHtml(entry.action)], ['目标', mono(entry.target)], ['操作者', escapeHtml(entry.actor)], ['时间', escapeHtml(entry.time)], ['结果', status(entry.failed ? '未通过' : '成功', entry.failed ? 'bad' : 'good')], ['详情', escapeHtml(entry.detail)]]), '完成', () => { }); }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'admin-search') { search = event.target.value; renderRows(); }
    if (event.target.name === 'baseUrl' && urlContext) { urlContext.validation = null; document.getElementById('admin-url-result').innerHTML = ''; modal.querySelector('[role=alert]').textContent = ''; modal.querySelector('button[type=submit]').disabled = true; }
  });
  document.addEventListener('change', event => { if (event.target.id === 'admin-filter') { filter = event.target.value; renderRows(); } });
  modal.addEventListener('close', () => {
    urlContext = null;
    const trigger = [...document.querySelectorAll('#admin-app [data-action]')].find(element => element.dataset.action === modalTrigger?.action && element.dataset.id === modalTrigger?.id);
    trigger?.focus();
  });
  navDialog.addEventListener('click', event => { if (event.target.closest('a')) navDialog.close(); });
  window.addEventListener('hashchange', () => { search = ''; filter = ''; activeTab = 'config'; if (modal.open) modal.close(); render(); });
  render();
})();