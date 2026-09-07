const psdMock = (() => {
  const photo = 'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1000&q=85';
  const images = new Map();
  let selection = 'headline';
  let regionStart = null;
  let activeRegion = null;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const symbol = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const initial = () => ({
    width: 1200, height: 800, layers: [
      { id: 'background', name: '背景', kind: 'rect', x: 0, y: 0, width: 1200, height: 800, color: '#e8eddf', visible: true },
      { id: 'photo', name: '空间摄影', kind: 'image', x: 620, y: 0, width: 580, height: 800, src: photo, visible: true },
      { id: 'line', name: '分隔线', kind: 'rect', x: 64, y: 168, width: 470, height: 2, color: '#829274', visible: true },
      { id: 'brand', name: '品牌', kind: 'text', x: 64, y: 76, width: 470, height: 58, text: 'UniDocs / STUDIO', size: 27, color: '#3f523c', visible: true },
      { id: 'headline', name: '标题', kind: 'text', x: 60, y: 248, width: 510, height: 240, text: 'Ideas,\nin good company.', size: 64, color: '#28362a', visible: true },
      { id: 'caption', name: '副标题', kind: 'text', x: 64, y: 588, width: 470, height: 90, text: '给想法一个空间。\n与 AI 一起，让创作继续。', size: 27, color: '#53664c', visible: true },
      { id: 'edition', name: '期号', kind: 'text', x: 64, y: 734, width: 450, height: 30, text: 'FIELD NOTES     /     001', size: 17, color: '#67755c', visible: true }
    ]
  });
  function parse(content) {
    try { const data = JSON.parse(content); return Array.isArray(data.layers) && data.width > 0 && data.height > 0 ? data : null; } catch { return null; }
  }
  function sample() {
    const first = initial();
    const second = initial();
    second.layers.find(layer => layer.id === 'headline').text = 'Space for\nyour next idea.';
    return {
      id: 'studio-cover', type: 'psd', title: '共创空间 · 封面设计', tags: ['设计', 'UniDocs'], author: 'Agent', updated: '12 分钟前', versions: [
        { number: 1, title: '共创空间 · 封面设计', author: '你', content: JSON.stringify(first) },
        { number: 2, title: '共创空间 · 封面设计', author: 'Agent', content: JSON.stringify(second) }
      ]
    };
  }
  function summary(content) {
    const data = parse(content);
    return data ? `${data.width} × ${data.height} · ${data.layers.length} 个图层 · ${data.layers.filter(layer => layer.kind === 'text' && layer.visible).map(layer => layer.text.replace(/\n/g, ' ')).join(' · ')}` : '';
  }
  function loadImage(src) {
    if (!images.has(src)) images.set(src, new Promise(resolve => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    }));
    return images.get(src);
  }
  async function draw(canvas, content) {
    const data = parse(content);
    if (!data) return;
    const ticket = Symbol();
    canvas.paintTicket = ticket;
    canvas.dataset.ready = 'false';
    const loaded = await Promise.all(data.layers.map(layer => layer.kind === 'image' && layer.visible ? loadImage(layer.src) : null));
    await Promise.all(data.layers.filter(layer => layer.kind === 'text' && layer.visible).map(layer => document.fonts.load(`${layer.id === 'headline' ? '500' : '400'} ${layer.size}px "Noto Sans SC"`, layer.text).catch(() => [])));
    if (canvas.paintTicket !== ticket) return;
    canvas.width = data.width; canvas.height = data.height;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, data.width, data.height);
    data.layers.forEach((layer, index) => {
      if (!layer.visible) return;
      context.save();
      context.beginPath(); context.rect(layer.x, layer.y, layer.width, layer.height); context.clip();
      context.fillStyle = layer.color || '#d7ddd1';
      if (layer.kind === 'rect') context.fillRect(layer.x, layer.y, layer.width, layer.height);
      if (layer.kind === 'text') {
        let size = layer.size;
        let lines;
        do {
          context.font = `${layer.id === 'headline' ? '500' : '400'} ${size}px "Noto Sans SC", sans-serif`;
          lines = layer.text.split('\n').flatMap(paragraph => {
            const wrapped = []; let line = '';
            for (const character of paragraph) {
              if (line && context.measureText(line + character).width > layer.width) { wrapped.push(line); line = ''; }
              line += character;
            }
            wrapped.push(line); return wrapped;
          });
          if (lines.length * size * 1.3 <= layer.height || size <= 8) break;
          size -= 1;
        } while (size >= 8);
        context.textBaseline = 'top';
        lines.forEach((line, lineIndex) => context.fillText(line, layer.x, layer.y + lineIndex * size * 1.3));
      }
      if (layer.kind === 'image') {
        const image = loaded[index];
        if (image) {
          const scale = Math.max(layer.width / image.width, layer.height / image.height);
          context.drawImage(image, layer.x + (layer.width - image.width * scale) / 2, layer.y + (layer.height - image.height * scale) / 2, image.width * scale, image.height * scale);
        } else {
          context.fillRect(layer.x, layer.y, layer.width, layer.height);
          context.fillStyle = '#53664c'; context.font = '24px sans-serif'; context.fillText('图片加载失败', layer.x + 24, layer.y + 50);
        }
      }
      context.restore();
    });
    canvas.dataset.ready = 'true';
    canvas.dataset.imageErrors = String(loaded.filter((image, index) => data.layers[index].kind === 'image' && data.layers[index].visible && !image).length);
  }
  function setBox(element, box, data) {
    element.style.cssText = `left:${box.x / data.width * 100}%;top:${box.y / data.height * 100}%;width:${box.width / data.width * 100}%;height:${box.height / data.height * 100}%`;
  }
  function properties(root, content, onChange) {
    const data = parse(content);
    const layer = data.layers.find(item => item.id === selection) || data.layers.at(-1);
    selection = layer.id;
    root.querySelector('#psd-properties').innerHTML = `<h3>图层属性</h3><div class="psd-property-name">${escape(layer.name)}</div>${layer.kind === 'text' ? `<label class="field-label" for="layer-text">文本</label><textarea id="layer-text" rows="4">${escape(layer.text)}</textarea>` : ''}<div class="psd-coordinates"><label>X<input id="layer-x" type="number" min="0" max="${data.width - 1}" value="${layer.x}"></label><label>Y<input id="layer-y" type="number" min="0" max="${data.height - 1}" value="${layer.y}"></label></div>${layer.kind === 'text' ? `<label class="field-label" for="layer-size">字号</label><input id="layer-size" type="number" min="8" max="160" value="${layer.size}">` : ''}`;
    const bounds = root.querySelector('.psd-layer-bounds');
    setBox(bounds, layer, data); bounds.hidden = !layer.visible;
    root.querySelectorAll('[data-layer-select]').forEach(button => { button.classList.toggle('active', button.dataset.layerSelect === selection); });
    root.querySelector('#psd-properties').oninput = event => {
      const property = { 'layer-text': 'text', 'layer-x': 'x', 'layer-y': 'y', 'layer-size': 'size' }[event.target.id];
      if (!property) return;
      if (property === 'text') layer.text = event.target.value;
      else { if (event.target.value === '' || !event.target.validity.valid) return; layer[property] = Number(event.target.value); }
      const changed = JSON.stringify(data);
      onChange(changed); root.psdContent = changed;
      draw(root.querySelector('#psd-canvas'), changed); setBox(bounds, layer, data);
    };
  }
  function mount(root, content, { editing, onChange, onRegion, regions = [], focusRegion = false }) {
    const data = parse(content);
    if (!data) { root.innerHTML = '<div class="empty">无法读取画布</div>'; return; }
    root.psdContent = content;
    root.innerHTML = `<div class="psd-surface ${editing ? 'is-editing' : ''}"><div class="psd-main"><div class="psd-tools row spread"><span>${data.width} × ${data.height} px</span><span>${editing ? 'RGB · 图层编辑' : 'RGB · 版本预览'}</span></div><div class="psd-stage"><div class="psd-artboard ${editing ? '' : 'annotatable'}" style="aspect-ratio:${data.width}/${data.height}"><canvas id="psd-canvas" aria-label="PSD 作品画布"></canvas><div class="psd-layer-bounds" hidden></div><div class="psd-region-selection" hidden></div></div></div><div class="psd-status row spread"><span>${data.layers.length} 个图层</span><span>适合画布</span></div></div>${editing ? `<aside class="psd-inspector"><h3>图层</h3><div class="psd-layer-list">${[...data.layers].reverse().map(layer => `<div class="psd-layer-row"><button class="ghost" data-layer-select="${layer.id}">${symbol(layer.kind === 'text' ? 'type' : layer.kind === 'image' ? 'image' : 'square')}<span>${escape(layer.name)}</span></button><button class="icon ghost" data-layer-toggle="${layer.id}" title="${layer.visible ? '隐藏' : '显示'}${escape(layer.name)}" aria-label="${layer.visible ? '隐藏' : '显示'}${escape(layer.name)}">${symbol(layer.visible ? 'eye' : 'eye-off')}</button></div>`).join('')}</div><div id="psd-properties"></div></aside>` : ''}</div>`;
    draw(root.querySelector('#psd-canvas'), content);
    const board = root.querySelector('.psd-artboard');
    if (editing) {
      properties(root, content, onChange);
      root.querySelectorAll('[data-layer-select]').forEach(button => button.onclick = () => { selection = button.dataset.layerSelect; properties(root, root.psdContent, onChange); });
      root.querySelectorAll('[data-layer-toggle]').forEach(button => button.onclick = () => {
        const changed = parse(root.psdContent); const layer = changed.layers.find(item => item.id === button.dataset.layerToggle); layer.visible = !layer.visible;
        const next = JSON.stringify(changed); onChange(next); mount(root, next, { editing, onChange, onRegion, regions });
        if (window.lucide) lucide.createIcons();
      });
    } else {
      const visibility = new Map(data.layers.map(layer => [layer.id, layer.visible]));
      let solo = null;
      const panel = document.createElement('aside'); panel.className = 'psd-inspector psd-preview-inspector';
      panel.innerHTML = `<div class="psd-preview-heading row spread"><h3>分图层预览</h3><button class="icon ghost" data-preview-reset title="恢复原始显示" aria-label="恢复原始显示">${symbol('rotate-ccw')}</button></div><div class="psd-preview-layers">${[...data.layers].reverse().map(layer => `<div class="psd-preview-layer"><span class="psd-layer-mini">${thumbnail(JSON.stringify({ ...data, layers: [ { ...layer, visible: true } ] }), layer.name)}</span><span class="psd-preview-label">${escape(layer.name)}</span><button class="icon ghost" data-preview-toggle="${layer.id}" title="切换${escape(layer.name)}可见性" aria-label="切换${escape(layer.name)}可见性"></button><button class="icon ghost" data-preview-solo="${layer.id}" title="单独查看${escape(layer.name)}" aria-label="单独查看${escape(layer.name)}">${symbol('scan')}</button></div>`).join('')}</div><div class="psd-preview-summary"></div>`;
      root.querySelector('.psd-surface').append(panel);
      const toggle = document.createElement('button'); toggle.className = 'small ghost'; toggle.innerHTML = `${symbol('layers')}图层`; toggle.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-label', '展开或收起图层预览');
      root.querySelector('.psd-tools').append(toggle);
      toggle.onclick = () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); };
      const visibleLayers = () => data.layers.filter(layer => solo ? layer.id === solo : visibility.get(layer.id));
      const refresh = () => {
        const visible = visibleLayers();
        const view = { ...data, layers: data.layers.map(layer => ({ ...layer, visible: visible.some(item => item.id === layer.id) })) };
        draw(root.querySelector('#psd-canvas'), JSON.stringify(view));
        panel.querySelectorAll('[data-preview-toggle]').forEach(button => {
          const shown = visible.some(layer => layer.id === button.dataset.previewToggle);
          button.setAttribute('aria-pressed', String(shown)); button.innerHTML = symbol(shown ? 'eye' : 'eye-off');
        });
        panel.querySelectorAll('[data-preview-solo]').forEach(button => { button.setAttribute('aria-pressed', String(solo === button.dataset.previewSolo)); });
        panel.querySelector('.psd-preview-summary').textContent = solo ? `单层 · ${visible[0].name}` : `${visible.length} / ${data.layers.length} 个图层可见`;
        if (window.lucide) lucide.createIcons();
      };
      panel.querySelectorAll('[data-preview-toggle]').forEach(button => button.onclick = () => {
        if (solo) { data.layers.forEach(layer => visibility.set(layer.id, layer.id === solo)); solo = null; }
        const id = button.dataset.previewToggle; visibility.set(id, !visibility.get(id)); refresh();
      });
      panel.querySelectorAll('[data-preview-solo]').forEach(button => button.onclick = () => { solo = solo === button.dataset.previewSolo ? null : button.dataset.previewSolo; refresh(); });
      panel.querySelector('[data-preview-reset]').onclick = () => { solo = null; data.layers.forEach(layer => visibility.set(layer.id, layer.visible)); refresh(); };
      if (focusRegion && regions.length === 1 && regions[0].visibleLayerIds) data.layers.forEach(layer => visibility.set(layer.id, regions[0].visibleLayerIds.includes(layer.id)));
      refresh(); paintThumbnails(panel);
      regions.forEach(region => {
        const marker = document.createElement('div'); marker.className = 'psd-region-marker'; setBox(marker, region, data); board.append(marker);
      });
      const point = event => { const bounds = board.getBoundingClientRect(); return { x: Math.round(Math.max(0, Math.min(data.width, (event.clientX - bounds.left) / bounds.width * data.width))), y: Math.round(Math.max(0, Math.min(data.height, (event.clientY - bounds.top) / bounds.height * data.height))) }; };
      board.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); regionStart = point(event); board.setPointerCapture(event.pointerId); activeRegion = null; };
      board.onpointermove = event => {
        if (!regionStart) return;
        const end = point(event); activeRegion = { x: Math.min(regionStart.x, end.x), y: Math.min(regionStart.y, end.y), width: Math.abs(end.x - regionStart.x), height: Math.abs(end.y - regionStart.y) };
        const box = root.querySelector('.psd-region-selection'); box.hidden = false; setBox(box, activeRegion, data);
      };
      board.onpointerup = () => { regionStart = null; if (activeRegion?.width > 8 && activeRegion?.height > 8) onRegion({ ...activeRegion, visibleLayerIds: visibleLayers().map(layer => layer.id) }); };
      board.onpointercancel = () => { regionStart = null; activeRegion = null; root.querySelector('.psd-region-selection').hidden = true; };
    }
  }
  function thumbnail(content, label = 'PSD 预览') { return `<canvas class="psd-thumbnail" data-psd-content="${escape(content)}" aria-label="${escape(label)}"></canvas>`; }
  function paintThumbnails(root) { root.querySelectorAll('canvas[data-psd-content]').forEach(canvas => draw(canvas, canvas.dataset.psdContent)); }
  async function exportPng(content, title) {
    const canvas = document.createElement('canvas'); await draw(canvas, content);
    if (canvas.dataset.imageErrors !== '0') throw new Error('图片尚未加载，无法导出');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('无法导出画布');
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = title.replace(/[<>:"/\\|?*]/g, '-') + '.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function agentUpdate(content) {
    const data = parse(content); const layer = data.layers.find(item => item.kind === 'text' && item.id === 'headline') || data.layers.find(item => item.kind === 'text');
    layer.text = layer.text === 'Create something\ntogether.' ? 'Space for\nyour next idea.' : 'Create something\ntogether.';
    return JSON.stringify(data);
  }
  return { initial: () => JSON.stringify(initial()), sample, parse, summary, mount, thumbnail, paintThumbnails, exportPng, agentUpdate };
})();