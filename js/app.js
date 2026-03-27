/**
 * DnD Fog of War – Dungeon Master Panel
 * js/app.js
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────
  const S = {
    layers: [],                        // index 0 = top-most layer
    fog: { canvas: null, ctx: null },  // offscreen fog mask
    vp: { x: 0, y: 0, zoom: 1 },      // viewport
    world: { w: 1920, h: 1080 },
    tool: 'reveal',                    // reveal | hide | pan | transform
    brushSize: 50,
    isDrawing: false,
    isPanning: false,
    panStart: null, vpStart: null,
    cursorWorld: null,
    lastFogPt: null,
    selectedId: null,
    isDraggingLayer: false,
    dragStart: null,                   // { mx,my,lx,ly }
    bc: null,                          // BroadcastChannel
    saveTimer: null,
    fogBroadcastTimer: null,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // DOM
  // ─────────────────────────────────────────────────────────────────────────
  let canvas, ctx;

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────
  function init() {
    canvas = document.getElementById('main-canvas');
    ctx    = canvas.getContext('2d');

    // Fog offscreen canvas
    S.fog.canvas = document.createElement('canvas');
    S.fog.ctx    = S.fog.canvas.getContext('2d');
    resetFog(S.world.w, S.world.h, true);

    // BroadcastChannel
    S.bc = new BroadcastChannel('dnd-fog');
    S.bc.onmessage = onBcMessage;

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    bindCanvasEvents();
    bindUIEvents();

    loadFromStorage();       // restore previous session
    requestAnimationFrame(renderLoop);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FOG
  // ─────────────────────────────────────────────────────────────────────────
  function resetFog(w, h, fillBlack) {
    S.fog.canvas.width  = w;
    S.fog.canvas.height = h;
    if (fillBlack) {
      S.fog.ctx.fillStyle = '#000';
      S.fog.ctx.fillRect(0, 0, w, h);
    }
  }

  function applyFog(wx, wy, tool) {
    const fc = S.fog.ctx;
    const r  = S.brushSize;
    fc.save();
    if (tool === 'reveal') {
      fc.globalCompositeOperation = 'destination-out';
    } else {
      fc.globalCompositeOperation = 'source-over';
      fc.fillStyle = '#000';
    }
    fc.beginPath();
    fc.arc(wx, wy, r, 0, Math.PI * 2);
    fc.fill();
    fc.restore();
  }

  function interpolateFog(x1, y1, x2, y2, tool) {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(d / (S.brushSize * 0.35)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      applyFog(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, tool);
    }
  }

  function revealAll() {
    const fc = S.fog.ctx;
    fc.save();
    fc.globalCompositeOperation = 'destination-out';
    fc.fillRect(0, 0, S.world.w, S.world.h);
    fc.restore();
    afterFogChange();
  }

  function hideAll() {
    const fc = S.fog.ctx;
    fc.save();
    fc.globalCompositeOperation = 'source-over';
    fc.fillStyle = '#000';
    fc.fillRect(0, 0, S.world.w, S.world.h);
    fc.restore();
    afterFogChange();
  }

  function afterFogChange() {
    broadcastFog();
    scheduleSave();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESIZE / FIT
  // ─────────────────────────────────────────────────────────────────────────
  function resizeCanvas() {
    const wrap   = document.getElementById('canvas-wrap');
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
  }

  function fitView() {
    const m = 36;
    const z = Math.min(
      (canvas.width  - m * 2) / S.world.w,
      (canvas.height - m * 2) / S.world.h
    );
    S.vp.zoom = z;
    S.vp.x = (canvas.width  - S.world.w * z) / 2;
    S.vp.y = (canvas.height - S.world.h * z) / 2;
  }

  function applyWorldSize(w, h) {
    const oldFogCanvas = document.createElement('canvas');
    oldFogCanvas.width  = S.fog.canvas.width;
    oldFogCanvas.height = S.fog.canvas.height;
    oldFogCanvas.getContext('2d').drawImage(S.fog.canvas, 0, 0);

    S.world.w = w;
    S.world.h = h;
    // Don't pre-fill with black: drawImage preserves transparency so revealed
    // areas (α=0) in the old fog remain revealed in the scaled new fog.
    // Fogged areas (opaque black) are drawn correctly with source-over.
    resetFog(w, h, false);
    S.fog.ctx.drawImage(oldFogCanvas, 0, 0, w, h);
    // Fill any still-transparent pixels with black (safety net for edge cases)
    S.fog.ctx.globalCompositeOperation = 'destination-over';
    S.fog.ctx.fillStyle = '#000';
    S.fog.ctx.fillRect(0, 0, w, h);
    S.fog.ctx.globalCompositeOperation = 'source-over';

    document.getElementById('world-w').value = w;
    document.getElementById('world-h').value = h;
    fitView();
    broadcastFull();
    scheduleSave();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COORDINATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  function screenToWorld(sx, sy) {
    return {
      x: (sx - S.vp.x) / S.vp.zoom,
      y: (sy - S.vp.y) / S.vp.zoom,
    };
  }

  function getCanvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  function renderLoop() {
    requestAnimationFrame(renderLoop);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#03030b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(S.vp.x, S.vp.y);
    ctx.scale(S.vp.zoom, S.vp.zoom);

    // World background
    ctx.fillStyle = '#0d0d1e';
    ctx.fillRect(0, 0, S.world.w, S.world.h);

    // Grid
    if (document.getElementById('show-grid').checked) {
      const gs = parseInt(document.getElementById('grid-size').value) || 50;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1 / S.vp.zoom;
      for (let x = 0; x <= S.world.w; x += gs) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S.world.h); ctx.stroke();
      }
      for (let y = 0; y <= S.world.h; y += gs) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S.world.w, y); ctx.stroke();
      }
      ctx.restore();
    }

    // Layers – drawn bottom (end of array) → top (index 0)
    for (let i = S.layers.length - 1; i >= 0; i--) {
      const l = S.layers[i];
      if (!l.visible || !l.img || !l.img.complete) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.img, l.x, l.y, l.w * l.sx, l.h * l.sy);

      // Selection outline (transform tool)
      if (l.id === S.selectedId && S.tool === 'transform') {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#f5a623';
        ctx.lineWidth = 2 / S.vp.zoom;
        ctx.setLineDash([6 / S.vp.zoom, 4 / S.vp.zoom]);
        ctx.strokeRect(l.x, l.y, l.w * l.sx, l.h * l.sy);
        ctx.setLineDash([]);
        drawCornerHandles(l);
      }
      ctx.restore();
    }

    // Fog – semi-transparent for DM
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.drawImage(S.fog.canvas, 0, 0);
    ctx.restore();

    // Brush cursor (reveal / hide only)
    if (S.cursorWorld && (S.tool === 'reveal' || S.tool === 'hide')) {
      ctx.save();
      ctx.strokeStyle = S.tool === 'reveal'
        ? 'rgba(255,200,40,0.85)'
        : 'rgba(80,80,255,0.85)';
      ctx.lineWidth = 2 / S.vp.zoom;
      ctx.setLineDash([5 / S.vp.zoom, 5 / S.vp.zoom]);
      ctx.beginPath();
      ctx.arc(S.cursorWorld.x, S.cursorWorld.y, S.brushSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function drawCornerHandles(l) {
    const hw = l.w * l.sx;
    const hh = l.h * l.sy;
    const r  = 6 / S.vp.zoom;
    [[l.x, l.y], [l.x + hw, l.y], [l.x, l.y + hh], [l.x + hw, l.y + hh]].forEach(([cx, cy]) => {
      ctx.fillStyle = '#f5a623';
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CANVAS EVENT HANDLERS
  // ─────────────────────────────────────────────────────────────────────────
  function bindCanvasEvents() {
    canvas.addEventListener('mousedown',   onMouseDown);
    canvas.addEventListener('mousemove',   onMouseMove);
    canvas.addEventListener('mouseup',     onMouseUp);
    canvas.addEventListener('mouseleave',  onMouseLeave);
    canvas.addEventListener('wheel',       onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('dragover',    e => e.preventDefault());
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('touchstart',  onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',    onTouchEnd);
  }

  function onMouseDown(e) {
    e.preventDefault();
    const s = getCanvasXY(e);
    const w = screenToWorld(s.x, s.y);

    // Middle-click, right-click, alt+click or pan tool → pan
    if (e.button === 1 || e.button === 2 || e.altKey || S.tool === 'pan' || canvas.dataset.spaceHeld === '1') {
      S.isPanning = true;
      S.panStart  = s;
      S.vpStart   = { ...S.vp };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (S.tool === 'reveal' || S.tool === 'hide') {
      S.isDrawing  = true;
      S.lastFogPt  = w;
      applyFog(w.x, w.y, S.tool);
      return;
    }

    if (S.tool === 'transform') {
      const hit = hitTestLayer(w.x, w.y);
      if (hit) {
        S.selectedId     = hit.id;
        S.isDraggingLayer = true;
        S.dragStart      = { mx: w.x, my: w.y, lx: hit.x, ly: hit.y };
      } else {
        S.selectedId = null;
      }
      rebuildLayerPanel();
    }
  }

  function onMouseMove(e) {
    const s = getCanvasXY(e);
    const w = screenToWorld(s.x, s.y);
    S.cursorWorld = w;

    if (S.isPanning) {
      S.vp.x = S.vpStart.x + (s.x - S.panStart.x);
      S.vp.y = S.vpStart.y + (s.y - S.panStart.y);
      throttleBroadcastViewport();
      return;
    }

    if (S.isDrawing && (S.tool === 'reveal' || S.tool === 'hide')) {
      if (S.lastFogPt) interpolateFog(S.lastFogPt.x, S.lastFogPt.y, w.x, w.y, S.tool);
      S.lastFogPt = w;
      throttleBroadcastFog();
      return;
    }

    if (S.isDraggingLayer && S.selectedId) {
      const l = S.layers.find(x => x.id === S.selectedId);
      if (l) {
        l.x = S.dragStart.lx + (w.x - S.dragStart.mx);
        l.y = S.dragStart.ly + (w.y - S.dragStart.my);
        syncLayerInputs(l);
        throttleBroadcastFull();
      }
    }
  }

  function onMouseUp() {
    const wasDraw  = S.isDrawing;
    const wasDrag  = S.isDraggingLayer;
    S.isDrawing     = false;
    S.isPanning     = false;
    S.isDraggingLayer = false;
    S.lastFogPt     = null;
    updateCursor();

    if (wasDraw) { broadcastFog();  scheduleSave(); }
    if (wasDrag) { broadcastFull(); scheduleSave(); }
  }

  function onMouseLeave() {
    S.cursorWorld = null;
    onMouseUp();
  }

  function onWheel(e) {
    e.preventDefault();
    const s   = getCanvasXY(e);
    const f   = e.deltaY < 0 ? 1.12 : 0.89;
    const nz  = Math.max(0.04, Math.min(25, S.vp.zoom * f));
    const w   = screenToWorld(s.x, s.y);
    S.vp.zoom = nz;
    S.vp.x    = s.x - w.x * nz;
    S.vp.y    = s.y - w.y * nz;
    throttleBroadcastViewport();
  }

  function onDrop(e) {
    e.preventDefault();
    processImageFiles(e.dataTransfer.files);
  }

  // ── Touch support ──────────────────────────────────────────────────────────
  let _tDist = 0;
  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      onMouseDown({ clientX: t.clientX, clientY: t.clientY,
        button: S.tool === 'pan' ? 1 : 0, altKey: false, preventDefault() {} });
    } else if (e.touches.length === 2) {
      _tDist = tDist(e.touches);
    }
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      onMouseMove({ clientX: t.clientX, clientY: t.clientY });
    } else if (e.touches.length === 2) {
      const nd = tDist(e.touches);
      const tc = tCenter(e.touches);
      const s  = getCanvasXY({ clientX: tc.x, clientY: tc.y });
      const f  = nd / _tDist;
      const nz = Math.max(0.04, Math.min(25, S.vp.zoom * f));
      const w  = screenToWorld(s.x, s.y);
      S.vp.zoom = nz;
      S.vp.x    = s.x - w.x * nz;
      S.vp.y    = s.y - w.y * nz;
      _tDist = nd;
    }
  }
  function onTouchEnd(e) { if (e.touches.length === 0) onMouseUp(); }
  function tDist(ts) { return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY); }
  function tCenter(ts) { return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 }; }

  // ─────────────────────────────────────────────────────────────────────────
  // HIT TEST
  // ─────────────────────────────────────────────────────────────────────────
  function hitTestLayer(wx, wy) {
    for (const l of S.layers) {
      if (!l.visible) continue;
      if (wx >= l.x && wx <= l.x + l.w * l.sx && wy >= l.y && wy <= l.y + l.h * l.sy) return l;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CURSOR
  // ─────────────────────────────────────────────────────────────────────────
  function updateCursor() {
    canvas.style.cursor = { reveal: 'crosshair', hide: 'crosshair', pan: 'grab', transform: 'default' }[S.tool] || 'default';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────
  function makeLayer(name, dataURL, img) {
    return {
      id:      'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name,
      dataURL,
      img,
      x: 0, y: 0,
      w: img.naturalWidth  || img.width  || 100,
      h: img.naturalHeight || img.height || 100,
      sx: 1, sy: 1,
      opacity: 1,
      visible: true,
    };
  }

  function addLayer(layer) {
    S.layers.unshift(layer);   // new layer on top
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function removeLayer(id) {
    if (S.selectedId === id) S.selectedId = null;
    S.layers = S.layers.filter(l => l.id !== id);
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function moveLayer(id, delta) {
    const i = S.layers.findIndex(l => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= S.layers.length) return;
    [S.layers[i], S.layers[j]] = [S.layers[j], S.layers[i]];
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER PANEL UI
  // ─────────────────────────────────────────────────────────────────────────
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function rebuildLayerPanel() {
    const ul = document.getElementById('layer-list');
    if (S.layers.length === 0) {
      ul.innerHTML = '<li class="empty-hint">No layers.<br>Click <b>+ Add</b> or drop images onto the canvas.</li>';
      return;
    }
    ul.innerHTML = '';
    S.layers.forEach((l, idx) => {
      const sel = l.id === S.selectedId;
      const li  = document.createElement('li');
      li.className = 'layer-item' + (sel ? ' selected' : '') + (l.visible ? '' : ' faded');
      li.dataset.id = l.id;
      li.innerHTML = `
        <div class="layer-row">
          <button class="vis-btn" data-id="${l.id}" title="Toggle visibility">${l.visible ? '👁' : '🙈'}</button>
          <span class="layer-name-edit" contenteditable="true" spellcheck="false" data-id="${l.id}">${esc(l.name)}</span>
          <div class="layer-order-btns">
            <button class="btn-up" data-id="${l.id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn-dn" data-id="${l.id}" ${idx === S.layers.length - 1 ? 'disabled' : ''}>▼</button>
          </div>
          <button class="layer-del-btn" data-id="${l.id}" title="Delete layer">✕</button>
        </div>
        <div class="layer-props">
          <label><span>Opacity</span>
            <input type="range" class="inp-op" data-id="${l.id}" min="0" max="1" step="0.01" value="${l.opacity}">
          </label>
          <div class="pos-grid">
            <label>X <input type="number" class="inp-x"  data-id="${l.id}" value="${Math.round(l.x)}"></label>
            <label>Y <input type="number" class="inp-y"  data-id="${l.id}" value="${Math.round(l.y)}"></label>
            <label>W% <input type="number" class="inp-sx" data-id="${l.id}" value="${Math.round(l.sx * 100)}" min="1"></label>
            <label>H% <input type="number" class="inp-sy" data-id="${l.id}" value="${Math.round(l.sy * 100)}" min="1"></label>
          </div>
          <button class="btn-fit-layer" data-id="${l.id}" style="width:100%;margin-top:3px;font-size:10px">Fit to World</button>
        </div>`;
      ul.appendChild(li);
    });

    // ── bind events ────────────────────────────────────────────────────────
    ul.querySelectorAll('.vis-btn').forEach(b => b.addEventListener('click', () => {
      const l = S.layers.find(x => x.id === b.dataset.id);
      if (l) { l.visible = !l.visible; rebuildLayerPanel(); broadcastFull(); scheduleSave(); }
    }));

    ul.querySelectorAll('.layer-name-edit').forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      el.addEventListener('blur', () => {
        const l = S.layers.find(x => x.id === el.dataset.id);
        if (l) { l.name = el.textContent.trim() || l.name; scheduleSave(); }
      });
    });

    ul.querySelectorAll('.btn-up').forEach(b => b.addEventListener('click', () => moveLayer(b.dataset.id, -1)));
    ul.querySelectorAll('.btn-dn').forEach(b => b.addEventListener('click', () => moveLayer(b.dataset.id, +1)));

    ul.querySelectorAll('.layer-del-btn').forEach(b => b.addEventListener('click', () => {
      const l = S.layers.find(x => x.id === b.dataset.id);
      if (l && confirm(`Delete layer "${l.name}"?`)) removeLayer(b.dataset.id);
    }));

    ul.querySelectorAll('.inp-op').forEach(inp => inp.addEventListener('input', () => {
      const l = S.layers.find(x => x.id === inp.dataset.id);
      if (l) { l.opacity = parseFloat(inp.value); broadcastFull(); scheduleSave(); }
    }));

    ul.querySelectorAll('.inp-x').forEach(inp => inp.addEventListener('change', () => {
      const l = S.layers.find(x => x.id === inp.dataset.id);
      if (l) { l.x = parseFloat(inp.value) || 0; broadcastFull(); scheduleSave(); }
    }));
    ul.querySelectorAll('.inp-y').forEach(inp => inp.addEventListener('change', () => {
      const l = S.layers.find(x => x.id === inp.dataset.id);
      if (l) { l.y = parseFloat(inp.value) || 0; broadcastFull(); scheduleSave(); }
    }));
    ul.querySelectorAll('.inp-sx').forEach(inp => inp.addEventListener('change', () => {
      const l = S.layers.find(x => x.id === inp.dataset.id);
      if (l) { l.sx = (parseFloat(inp.value) || 100) / 100; broadcastFull(); scheduleSave(); }
    }));
    ul.querySelectorAll('.inp-sy').forEach(inp => inp.addEventListener('change', () => {
      const l = S.layers.find(x => x.id === inp.dataset.id);
      if (l) { l.sy = (parseFloat(inp.value) || 100) / 100; broadcastFull(); scheduleSave(); }
    }));

    ul.querySelectorAll('.btn-fit-layer').forEach(b => b.addEventListener('click', () => {
      const l = S.layers.find(x => x.id === b.dataset.id);
      if (l) {
        l.x = 0; l.y = 0;
        l.sx = S.world.w / l.w;
        l.sy = S.world.h / l.h;
        syncLayerInputs(l);
        broadcastFull();
        scheduleSave();
        rebuildLayerPanel();
      }
    }));
  }

  /** Update the numeric inputs in the panel for a layer that was dragged */
  function syncLayerInputs(l) {
    const item = document.querySelector(`.layer-item[data-id="${l.id}"]`);
    if (!item) return;
    const xInp = item.querySelector('.inp-x');
    const yInp = item.querySelector('.inp-y');
    if (xInp) xInp.value = Math.round(l.x);
    if (yInp) yInp.value = Math.round(l.y);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMAGE FILE HANDLING
  // ─────────────────────────────────────────────────────────────────────────
  function processImageFiles(files) {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = e => {
        const dataURL = e.target.result;
        const img     = new Image();
        img.onload = () => {
          const layer = makeLayer(file.name.replace(/\.[^.]+$/, ''), dataURL, img);
          // Auto-scale first layer to fill world
          if (S.layers.length === 0) {
            layer.sx = S.world.w / layer.w;
            layer.sy = S.world.h / layer.h;
          }
          addLayer(layer);
          toast(`Layer "${layer.name}" added`);
        };
        img.src = dataURL;
      };
      reader.readAsDataURL(file);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BROADCAST CHANNEL
  // ─────────────────────────────────────────────────────────────────────────
  function onBcMessage(e) {
    if (e.data.type === 'PLAYER_HELLO') broadcastFull();
  }

  function broadcastFull() {
    if (!S.bc) return;
    S.bc.postMessage({
      type: 'FULL_STATE',
      payload: {
        world:  { ...S.world },
        vp:     { ...S.vp },
        fogURL: S.fog.canvas.toDataURL('image/png'),
        layers: S.layers.map(layerToDTO),
      },
    });
  }

  function broadcastFog() {
    if (!S.bc) return;
    S.bc.postMessage({
      type: 'FOG_UPDATE',
      payload: { fogURL: S.fog.canvas.toDataURL('image/png') },
    });
  }

  function broadcastViewport() {
    if (!S.bc) return;
    S.bc.postMessage({ type: 'VP_UPDATE', payload: { vp: { ...S.vp } } });
  }

  // Throttled versions to avoid flooding during drag / paint
  function throttleBroadcastFog() {
    if (S.fogBroadcastTimer) return;
    S.fogBroadcastTimer = setTimeout(() => { broadcastFog(); S.fogBroadcastTimer = null; }, 80);
  }
  let _vpTimer = null;
  function throttleBroadcastViewport() {
    if (_vpTimer) return;
    _vpTimer = setTimeout(() => { broadcastViewport(); _vpTimer = null; }, 50);
  }
  let _fullTimer = null;
  function throttleBroadcastFull() {
    if (_fullTimer) return;
    _fullTimer = setTimeout(() => { broadcastFull(); _fullTimer = null; }, 80);
  }

  function layerToDTO(l) {
    return { id: l.id, name: l.name, dataURL: l.dataURL,
             x: l.x, y: l.y, w: l.w, h: l.h, sx: l.sx, sy: l.sy,
             opacity: l.opacity, visible: l.visible };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO IMPORT / EXPORT
  // ─────────────────────────────────────────────────────────────────────────
  function buildScenario() {
    return {
      version:  2,
      exported: new Date().toISOString(),
      world:    { ...S.world },
      vp:       { ...S.vp },
      fogURL:   S.fog.canvas.toDataURL('image/png'),
      layers:   S.layers.map(layerToDTO),
    };
  }

  function exportScenario() {
    const json = JSON.stringify(buildScenario(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'dnd-scenario-' + new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '') + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Scenario exported');
  }

  function loadScenario(data) {
    // World
    const w = data.world?.w ?? data.world?.width  ?? S.world.w;
    const h = data.world?.h ?? data.world?.height ?? S.world.h;
    S.world.w = w; S.world.h = h;

    // Viewport
    if (data.vp) S.vp = { ...data.vp };

    // Fog
    resetFog(w, h, true);
    const fogURL = data.fogURL || data.fog;
    if (fogURL) {
      const fi = new Image();
      fi.onload = () => { S.fog.ctx.drawImage(fi, 0, 0); broadcastFog(); };
      fi.src = fogURL;
    }

    // Layers
    S.layers = [];
    const dtos = data.layers || [];
    let loaded = 0;
    if (dtos.length === 0) {
      finishLoad();
      return;
    }
    dtos.forEach((dto, idx) => {
      const img = new Image();
      img.onload = () => {
        S.layers[idx] = {
          id:      dto.id,
          name:    dto.name,
          dataURL: dto.dataURL,
          img,
          x: dto.x ?? 0, y: dto.y ?? 0,
          w: dto.w || img.naturalWidth,
          h: dto.h || img.naturalHeight,
          sx: dto.sx ?? dto.scaleX ?? 1,
          sy: dto.sy ?? dto.scaleY ?? 1,
          opacity: dto.opacity ?? 1,
          visible: dto.visible !== false,
        };
        loaded++;
        if (loaded === dtos.length) finishLoad();
      };
      img.onerror = () => {
          console.warn(`Failed to load image for layer "${dto.name}" (index ${idx})`);
          loaded++;
          if (loaded === dtos.length) finishLoad();
        };
      img.src = dto.dataURL;
    });

    function finishLoad() {
      S.layers = S.layers.filter(Boolean);
      document.getElementById('world-w').value = w;
      document.getElementById('world-h').value = h;
      rebuildLayerPanel();
      broadcastFull();
      toast('Scenario loaded');
    }
  }

  function clearScenario() {
    if (!confirm('Clear all layers and reset fog? This cannot be undone.')) return;
    S.layers = [];
    S.world  = { w: 1920, h: 1080 };
    S.vp     = { x: 0, y: 0, zoom: 1 };
    S.selectedId = null;
    resetFog(S.world.w, S.world.h, true);
    document.getElementById('world-w').value = S.world.w;
    document.getElementById('world-h').value = S.world.h;
    rebuildLayerPanel();
    fitView();
    broadcastFull();
    try { localStorage.removeItem('dnd-fog-v2'); } catch (_) {}
    toast('Scenario cleared');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOCAL STORAGE
  // ─────────────────────────────────────────────────────────────────────────
  const LS_KEY = 'dnd-fog-v2';

  function scheduleSave() {
    if (S.saveTimer) clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveToStorage, 1200);
  }

  function saveToStorage() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(buildScenario()));
    } catch (e) {
      console.warn('localStorage save failed:', e);
    }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        loadScenario(JSON.parse(raw));
        return;
      }
    } catch (e) {
      console.warn('localStorage load failed:', e);
    }
    fitView();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYER WINDOW
  // ─────────────────────────────────────────────────────────────────────────
  function openPlayerView() {
    const url = new URL('player.html', window.location.href).href;
    const win = window.open(url, 'dnd-fog-player',
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes');
    if (!win) alert('Could not open player window. Please allow pop-ups for this page.');
    else toast('Player window opened');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI EVENT BINDINGS
  // ─────────────────────────────────────────────────────────────────────────
  function bindUIEvents() {
    // Header
    document.getElementById('btn-fit').addEventListener('click', fitView);
    document.getElementById('btn-player').addEventListener('click', openPlayerView);
    document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-scenario').click());
    document.getElementById('btn-export').addEventListener('click', exportScenario);
    document.getElementById('btn-clear').addEventListener('click', clearScenario);

    // File inputs
    document.getElementById('file-img').addEventListener('change', e => {
      processImageFiles(e.target.files);
      e.target.value = '';
    });
    document.getElementById('file-scenario').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = ev => {
        try { loadScenario(JSON.parse(ev.target.result)); }
        catch (err) { alert('Could not parse scenario: ' + err.message); }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    // Layer add
    document.getElementById('btn-add-layer').addEventListener('click', () => document.getElementById('file-img').click());

    // Tool buttons
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        S.tool = btn.dataset.tool;
        updateCursor();
      });
    });

    // Brush size
    const brushSlider = document.getElementById('brush-size');
    const brushVal    = document.getElementById('brush-val');
    brushSlider.addEventListener('input', () => {
      S.brushSize = parseInt(brushSlider.value);
      brushVal.textContent = S.brushSize + ' px';
    });

    // Fog buttons
    document.getElementById('btn-reveal-all').addEventListener('click', revealAll);
    document.getElementById('btn-hide-all').addEventListener('click', hideAll);

    // World size
    document.getElementById('btn-apply-world').addEventListener('click', () => {
      const w = parseInt(document.getElementById('world-w').value);
      const h = parseInt(document.getElementById('world-h').value);
      if (w >= 100 && h >= 100) applyWorldSize(w, h);
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', e => {
      if (e.target.isContentEditable || e.target.tagName === 'INPUT') return;
      const map = { r: 'reveal', h: 'hide', p: 'pan', t: 'transform' };
      if (map[e.key.toLowerCase()]) {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.tool-btn[data-tool="${map[e.key.toLowerCase()]}"]`);
        if (btn) btn.classList.add('active');
        S.tool = map[e.key.toLowerCase()];
        updateCursor();
      }
      if (e.key === 'f' || e.key === 'F') fitView();
      // Space = pan while held
      if (e.code === 'Space' && !e.repeat) {
        canvas.style.cursor = 'grab';
        canvas.dataset.spaceHeld = '1';
      }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') {
        delete canvas.dataset.spaceHeld;
        updateCursor();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOAST NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOOT
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
