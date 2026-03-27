/**
 * DnD Fog of War – Dungeon Master Panel
 * js/app.js  (v3 – Layer Groups + Checkpoints)
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────
  const S = {
    groups: [],           // array of { id, name, visible, fog:{canvas,ctx}, layers[] }
    activeGroupId: null,  // id of the group currently being edited / shown to players
    checkpoints: [],      // array of { id, name, vp:{x,y,zoom} }
    vp: { x: 0, y: 0, zoom: 1 },
    world: { w: 1920, h: 1080 },
    tool: 'reveal',       // reveal | hide | pan | transform
    brushSize: 50,
    isDrawing: false,
    isPanning: false,
    panStart: null, vpStart: null,
    cursorWorld: null,
    lastFogPt: null,
    selectedId: null,
    isDraggingLayer: false,
    dragStart: null,
    bc: null,
    saveTimer: null,
    fogBroadcastTimer: null,
  };

  /** Return the currently active group (or first as fallback). Returns null if groups is empty. */
  function ag() {
    if (!S.groups.length) return null;
    return S.groups.find(g => g.id === S.activeGroupId) || S.groups[0];
  }

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

    const dg        = makeGroup('Surface');
    S.groups        = [dg];
    S.activeGroupId = dg.id;

    S.bc = new BroadcastChannel('dnd-fog');
    S.bc.onmessage = onBcMessage;

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    bindCanvasEvents();
    bindUIEvents();
    loadFromStorage();
    requestAnimationFrame(renderLoop);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────
  function makeGroup(name) {
    const fogCanvas = document.createElement('canvas');
    fogCanvas.width  = S.world.w;
    fogCanvas.height = S.world.h;
    const fogCtx = fogCanvas.getContext('2d');
    fogCtx.fillStyle = '#000';
    fogCtx.fillRect(0, 0, S.world.w, S.world.h);
    return {
      id:      'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name:    name || 'Group',
      visible: true,
      fog:     { canvas: fogCanvas, ctx: fogCtx },
      layers:  [],
    };
  }

  function addGroup() {
    const g = makeGroup('Group ' + (S.groups.length + 1));
    S.groups.push(g);
    switchGroup(g.id);
    toast('Group "' + g.name + '" added');
  }

  function removeGroup(id) {
    if (S.groups.length <= 1) { toast('Cannot remove the last group'); return; }
    const g = S.groups.find(x => x.id === id);
    if (!g) return;
    if (!confirm('Delete group "' + g.name + '" and all its layers?')) return;
    S.groups = S.groups.filter(x => x.id !== id);
    if (S.activeGroupId === id) S.activeGroupId = S.groups[0].id;
    rebuildGroupTabs();
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function switchGroup(id) {
    S.activeGroupId = id;
    S.selectedId    = null;
    rebuildGroupTabs();
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function rebuildGroupTabs() {
    const container = document.getElementById('group-tabs');
    container.innerHTML = '';
    S.groups.forEach(g => {
      const div = document.createElement('div');
      div.className = 'group-tab' +
        (g.id === S.activeGroupId ? ' active' : '') +
        (g.visible ? '' : ' faded');
      div.dataset.id = g.id;

      const visBtn  = document.createElement('button');
      visBtn.className = 'gt-vis';
      visBtn.title = 'Toggle visibility';
      visBtn.textContent = g.visible ? '\uD83D\uDC41' : '\uD83D\uDE48';

      const nameEl = document.createElement('span');
      nameEl.className = 'gt-name';
      nameEl.contentEditable = 'true';
      nameEl.spellcheck = false;
      nameEl.textContent = g.name;

      const delBtn = document.createElement('button');
      delBtn.className = 'gt-del';
      delBtn.title = 'Delete group';
      delBtn.textContent = '\u2715';

      div.appendChild(visBtn);
      div.appendChild(nameEl);
      div.appendChild(delBtn);
      container.appendChild(div);

      div.addEventListener('click', e => {
        if (e.target.closest('button') || e.target.isContentEditable) return;
        switchGroup(g.id);
      });

      visBtn.addEventListener('click', e => {
        e.stopPropagation();
        g.visible = !g.visible;
        rebuildGroupTabs();
        broadcastFull();
        scheduleSave();
      });

      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeGroup(g.id);
      });

      nameEl.addEventListener('click', e => e.stopPropagation());
      nameEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      });
      nameEl.addEventListener('blur', () => {
        g.name = nameEl.textContent.trim() || g.name;
        scheduleSave();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FOG  (operates on the active group's fog)
  // ─────────────────────────────────────────────────────────────────────────
  function applyFog(wx, wy, tool) {
    const fc = ag().fog.ctx;
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
    const fc = ag().fog.ctx;
    fc.save();
    fc.globalCompositeOperation = 'destination-out';
    fc.fillRect(0, 0, S.world.w, S.world.h);
    fc.restore();
    afterFogChange();
  }

  function hideAll() {
    const fc = ag().fog.ctx;
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
    const wrap = document.getElementById('canvas-wrap');
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
    S.groups.forEach(g => {
      const old = document.createElement('canvas');
      old.width  = g.fog.canvas.width;
      old.height = g.fog.canvas.height;
      old.getContext('2d').drawImage(g.fog.canvas, 0, 0);
      g.fog.canvas.width  = w;
      g.fog.canvas.height = h;
      g.fog.ctx.drawImage(old, 0, 0, w, h);
      g.fog.ctx.globalCompositeOperation = 'destination-over';
      g.fog.ctx.fillStyle = '#000';
      g.fog.ctx.fillRect(0, 0, w, h);
      g.fog.ctx.globalCompositeOperation = 'source-over';
    });
    S.world.w = w;
    S.world.h = h;
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

    const g = ag();
    if (!g) return;

    ctx.save();
    ctx.translate(S.vp.x, S.vp.y);
    ctx.scale(S.vp.zoom, S.vp.zoom);

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

    // Layers of the active group (bottom → top)
    for (let i = g.layers.length - 1; i >= 0; i--) {
      const l = g.layers[i];
      if (!l.visible || !l.img || !l.img.complete) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.img, l.x, l.y, l.w * l.sx, l.h * l.sy);
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

    // Fog – 65 % opacity so DM can see the map beneath
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.drawImage(g.fog.canvas, 0, 0);
    ctx.restore();

    // Checkpoint markers
    renderCheckpointMarkers();

    // Brush cursor
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

  function renderCheckpointMarkers() {
    if (!S.checkpoints.length) return;
    const r = Math.max(6, 7 / S.vp.zoom);
    S.checkpoints.forEach(cp => {
      const wx = (canvas.width  / 2 - cp.vp.x) / cp.vp.zoom;
      const wy = (canvas.height / 2 - cp.vp.y) / cp.vp.zoom;
      if (wx < -200 || wx > S.world.w + 200 || wy < -200 || wy > S.world.h + 200) return;
      ctx.save();
      ctx.fillStyle   = 'rgba(245,166,35,0.88)';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth   = 1.5 / S.vp.zoom;
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle    = '#fff';
      ctx.font         = 'bold ' + Math.max(7, 8 / S.vp.zoom) + 'px sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(cp.name, wx, wy - r - 2 / S.vp.zoom);
      ctx.restore();
    });
  }

  function drawCornerHandles(l) {
    const hw = l.w * l.sx;
    const hh = l.h * l.sy;
    const r  = 6 / S.vp.zoom;
    [[l.x, l.y], [l.x + hw, l.y], [l.x, l.y + hh], [l.x + hw, l.y + hh]].forEach(function (pt) {
      ctx.fillStyle = '#f5a623';
      ctx.fillRect(pt[0] - r, pt[1] - r, r * 2, r * 2);
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
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('dragover',    function (e) { e.preventDefault(); });
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('touchstart',  onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',    onTouchEnd);
  }

  function onMouseDown(e) {
    e.preventDefault();
    const s = getCanvasXY(e);
    const w = screenToWorld(s.x, s.y);

    if (e.button === 1 || e.button === 2 || e.altKey || S.tool === 'pan' || canvas.dataset.spaceHeld === '1') {
      S.isPanning = true;
      S.panStart  = s;
      S.vpStart   = { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (S.tool === 'reveal' || S.tool === 'hide') {
      S.isDrawing = true;
      S.lastFogPt = w;
      applyFog(w.x, w.y, S.tool);
      return;
    }

    if (S.tool === 'transform') {
      const hit = hitTestLayer(w.x, w.y);
      if (hit) {
        S.selectedId      = hit.id;
        S.isDraggingLayer = true;
        S.dragStart       = { mx: w.x, my: w.y, lx: hit.x, ly: hit.y };
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
      const l = ag().layers.find(function (x) { return x.id === S.selectedId; });
      if (l) {
        l.x = S.dragStart.lx + (w.x - S.dragStart.mx);
        l.y = S.dragStart.ly + (w.y - S.dragStart.my);
        syncLayerInputs(l);
        throttleBroadcastFull();
      }
    }
  }

  function onMouseUp() {
    const wasDraw = S.isDrawing;
    const wasDrag = S.isDraggingLayer;
    S.isDrawing       = false;
    S.isPanning       = false;
    S.isDraggingLayer = false;
    S.lastFogPt       = null;
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
    const s  = getCanvasXY(e);
    const f  = e.deltaY < 0 ? 1.12 : 0.89;
    const nz = Math.max(0.04, Math.min(25, S.vp.zoom * f));
    const w  = screenToWorld(s.x, s.y);
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
  var _tDist = 0;
  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      var t = e.touches[0];
      onMouseDown({ clientX: t.clientX, clientY: t.clientY,
        button: S.tool === 'pan' ? 1 : 0, altKey: false, preventDefault: function () {} });
    } else if (e.touches.length === 2) {
      _tDist = tDist(e.touches);
    }
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      var t = e.touches[0];
      onMouseMove({ clientX: t.clientX, clientY: t.clientY });
    } else if (e.touches.length === 2) {
      var nd = tDist(e.touches);
      var tc = tCenter(e.touches);
      var s  = getCanvasXY({ clientX: tc.x, clientY: tc.y });
      var f  = nd / _tDist;
      var nz = Math.max(0.04, Math.min(25, S.vp.zoom * f));
      var w  = screenToWorld(s.x, s.y);
      S.vp.zoom = nz;
      S.vp.x    = s.x - w.x * nz;
      S.vp.y    = s.y - w.y * nz;
      _tDist = nd;
    }
  }
  function onTouchEnd(e) { if (e.touches.length === 0) onMouseUp(); }
  function tDist(ts)  { return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY); }
  function tCenter(ts){ return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 }; }

  // ─────────────────────────────────────────────────────────────────────────
  // HIT TEST (active group only)
  // ─────────────────────────────────────────────────────────────────────────
  function hitTestLayer(wx, wy) {
    var layers = ag().layers;
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (!l.visible) continue;
      if (wx >= l.x && wx <= l.x + l.w * l.sx && wy >= l.y && wy <= l.y + l.h * l.sy) return l;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CURSOR
  // ─────────────────────────────────────────────────────────────────────────
  function updateCursor() {
    var map = { reveal: 'crosshair', hide: 'crosshair', pan: 'grab', transform: 'default' };
    canvas.style.cursor = map[S.tool] || 'default';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER MANAGEMENT  (active group)
  // ─────────────────────────────────────────────────────────────────────────
  function makeLayer(name, dataURL, img) {
    return {
      id:      'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name:    name,
      dataURL: dataURL,
      img:     img,
      x: 0, y: 0,
      w: img.naturalWidth  || img.width  || 100,
      h: img.naturalHeight || img.height || 100,
      sx: 1, sy: 1,
      opacity: 1,
      visible: true,
    };
  }

  function addLayer(layer) {
    ag().layers.unshift(layer);
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function removeLayer(id) {
    if (S.selectedId === id) S.selectedId = null;
    var g = ag();
    g.layers = g.layers.filter(function (l) { return l.id !== id; });
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function moveLayer(id, delta) {
    var layers = ag().layers;
    var i = layers.findIndex(function (l) { return l.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= layers.length) return;
    var tmp = layers[i]; layers[i] = layers[j]; layers[j] = tmp;
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER PANEL UI
  // ─────────────────────────────────────────────────────────────────────────
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function rebuildLayerPanel() {
    var ul     = document.getElementById('layer-list');
    var layers = ag() ? ag().layers : [];

    if (layers.length === 0) {
      ul.innerHTML = '<li class="empty-hint">No layers.<br>Click <b>+ Add</b> or drop images onto the canvas.</li>';
      return;
    }
    ul.innerHTML = '';
    layers.forEach(function (l, idx) {
      var sel = l.id === S.selectedId;
      var li  = document.createElement('li');
      li.className = 'layer-item' + (sel ? ' selected' : '') + (l.visible ? '' : ' faded');
      li.dataset.id = l.id;
      li.innerHTML =
        '<div class="layer-row">' +
          '<button class="vis-btn" data-id="' + l.id + '" title="Toggle visibility">' + (l.visible ? '\uD83D\uDC41' : '\uD83D\uDE48') + '</button>' +
          '<span class="layer-name-edit" contenteditable="true" spellcheck="false" data-id="' + l.id + '">' + esc(l.name) + '</span>' +
          '<div class="layer-order-btns">' +
            '<button class="btn-up" data-id="' + l.id + '"' + (idx === 0 ? ' disabled' : '') + '>\u25B2</button>' +
            '<button class="btn-dn" data-id="' + l.id + '"' + (idx === layers.length - 1 ? ' disabled' : '') + '>\u25BC</button>' +
          '</div>' +
          '<button class="layer-del-btn" data-id="' + l.id + '" title="Delete layer">\u2715</button>' +
        '</div>' +
        '<div class="layer-props">' +
          '<label><span>Opacity</span>' +
            '<input type="range" class="inp-op" data-id="' + l.id + '" min="0" max="1" step="0.01" value="' + l.opacity + '">' +
          '</label>' +
          '<div class="pos-grid">' +
            '<label>X <input type="number" class="inp-x"  data-id="' + l.id + '" value="' + Math.round(l.x) + '"></label>' +
            '<label>Y <input type="number" class="inp-y"  data-id="' + l.id + '" value="' + Math.round(l.y) + '"></label>' +
            '<label>W% <input type="number" class="inp-sx" data-id="' + l.id + '" value="' + Math.round(l.sx * 100) + '" min="1"></label>' +
            '<label>H% <input type="number" class="inp-sy" data-id="' + l.id + '" value="' + Math.round(l.sy * 100) + '" min="1"></label>' +
          '</div>' +
          '<button class="btn-fit-layer" data-id="' + l.id + '" style="width:100%;margin-top:3px;font-size:10px">Fit to World</button>' +
        '</div>';
      ul.appendChild(li);
    });

    ul.querySelectorAll('.vis-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = ag().layers.find(function (x) { return x.id === b.dataset.id; });
        if (l) { l.visible = !l.visible; rebuildLayerPanel(); broadcastFull(); scheduleSave(); }
      });
    });

    ul.querySelectorAll('.layer-name-edit').forEach(function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      el.addEventListener('blur', function () {
        var l = ag().layers.find(function (x) { return x.id === el.dataset.id; });
        if (l) { l.name = el.textContent.trim() || l.name; scheduleSave(); }
      });
    });

    ul.querySelectorAll('.btn-up').forEach(function (b) {
      b.addEventListener('click', function () { moveLayer(b.dataset.id, -1); });
    });
    ul.querySelectorAll('.btn-dn').forEach(function (b) {
      b.addEventListener('click', function () { moveLayer(b.dataset.id, +1); });
    });

    ul.querySelectorAll('.layer-del-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = ag().layers.find(function (x) { return x.id === b.dataset.id; });
        if (l && confirm('Delete layer "' + l.name + '"?')) removeLayer(b.dataset.id);
      });
    });

    ul.querySelectorAll('.inp-op').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var l = ag().layers.find(function (x) { return x.id === inp.dataset.id; });
        if (l) { l.opacity = parseFloat(inp.value); broadcastFull(); scheduleSave(); }
      });
    });

    ul.querySelectorAll('.inp-x').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var l = ag().layers.find(function (x) { return x.id === inp.dataset.id; });
        if (l) { l.x = parseFloat(inp.value) || 0; broadcastFull(); scheduleSave(); }
      });
    });
    ul.querySelectorAll('.inp-y').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var l = ag().layers.find(function (x) { return x.id === inp.dataset.id; });
        if (l) { l.y = parseFloat(inp.value) || 0; broadcastFull(); scheduleSave(); }
      });
    });
    ul.querySelectorAll('.inp-sx').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var l = ag().layers.find(function (x) { return x.id === inp.dataset.id; });
        if (l) { l.sx = (parseFloat(inp.value) || 100) / 100; broadcastFull(); scheduleSave(); }
      });
    });
    ul.querySelectorAll('.inp-sy').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var l = ag().layers.find(function (x) { return x.id === inp.dataset.id; });
        if (l) { l.sy = (parseFloat(inp.value) || 100) / 100; broadcastFull(); scheduleSave(); }
      });
    });

    ul.querySelectorAll('.btn-fit-layer').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = ag().layers.find(function (x) { return x.id === b.dataset.id; });
        if (l) {
          l.x = 0; l.y = 0;
          l.sx = S.world.w / l.w;
          l.sy = S.world.h / l.h;
          syncLayerInputs(l);
          broadcastFull();
          scheduleSave();
          rebuildLayerPanel();
        }
      });
    });
  }

  function syncLayerInputs(l) {
    var item = document.querySelector('.layer-item[data-id="' + l.id + '"]');
    if (!item) return;
    var xInp = item.querySelector('.inp-x');
    var yInp = item.querySelector('.inp-y');
    if (xInp) xInp.value = Math.round(l.x);
    if (yInp) yInp.value = Math.round(l.y);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMAGE FILE HANDLING
  // ─────────────────────────────────────────────────────────────────────────
  function processImageFiles(files) {
    Array.from(files).forEach(function (file) {
      if (!file.type.startsWith('image/')) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        var dataURL = e.target.result;
        var img     = new Image();
        img.onload = function () {
          var layer = makeLayer(file.name.replace(/\.[^.]+$/, ''), dataURL, img);
          if (ag().layers.length === 0) {
            layer.sx = S.world.w / layer.w;
            layer.sy = S.world.h / layer.h;
          }
          addLayer(layer);
          toast('Layer "' + layer.name + '" added');
        };
        img.src = dataURL;
      };
      reader.readAsDataURL(file);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHECKPOINT MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────
  function saveCheckpoint() {
    var cp = {
      id:   'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: 'Checkpoint ' + (S.checkpoints.length + 1),
      vp:   { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom },
    };
    S.checkpoints.push(cp);
    rebuildCheckpointPanel();
    scheduleSave();
    toast('Checkpoint "' + cp.name + '" saved');
  }

  function removeCheckpoint(id) {
    S.checkpoints = S.checkpoints.filter(function (c) { return c.id !== id; });
    rebuildCheckpointPanel();
    scheduleSave();
  }

  function jumpToCheckpoint(id) {
    var cp = S.checkpoints.find(function (c) { return c.id === id; });
    if (!cp) return;
    S.vp.x    = cp.vp.x;
    S.vp.y    = cp.vp.y;
    S.vp.zoom = cp.vp.zoom;
    broadcastViewport();
    toast('Jumped to "' + cp.name + '"');
  }

  function rebuildCheckpointPanel() {
    var ul = document.getElementById('cp-list');
    if (!S.checkpoints.length) {
      ul.innerHTML = '<li class="empty-hint" style="font-size:10px;padding:8px 4px">No checkpoints yet.</li>';
      return;
    }
    ul.innerHTML = '';
    S.checkpoints.forEach(function (cp) {
      var li = document.createElement('li');
      li.className = 'cp-item';

      var nameEl = document.createElement('span');
      nameEl.className = 'cp-name-edit';
      nameEl.contentEditable = 'true';
      nameEl.spellcheck = false;
      nameEl.textContent = cp.name;

      var goBtn = document.createElement('button');
      goBtn.className = 'cp-go-btn';
      goBtn.title = 'Jump to checkpoint';
      goBtn.textContent = '\u25B6';

      var delBtn = document.createElement('button');
      delBtn.className = 'cp-del-btn';
      delBtn.title = 'Delete checkpoint';
      delBtn.textContent = '\u2715';

      li.appendChild(nameEl);
      li.appendChild(goBtn);
      li.appendChild(delBtn);
      ul.appendChild(li);

      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      });
      nameEl.addEventListener('blur', function () {
        cp.name = nameEl.textContent.trim() || cp.name;
        scheduleSave();
      });
      goBtn.addEventListener('click',  function () { jumpToCheckpoint(cp.id); });
      delBtn.addEventListener('click', function () { removeCheckpoint(cp.id); });
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
        world:         { w: S.world.w, h: S.world.h },
        vp:            { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom },
        activeGroupId: S.activeGroupId,
        groups:        S.groups.map(groupToDTO),
      },
    });
  }

  function broadcastFog() {
    if (!S.bc) return;
    var g = ag();
    S.bc.postMessage({
      type: 'FOG_UPDATE',
      payload: { groupId: g.id, fogURL: g.fog.canvas.toDataURL('image/png') },
    });
  }

  function broadcastViewport() {
    if (!S.bc) return;
    S.bc.postMessage({ type: 'VP_UPDATE', payload: { vp: { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom } } });
  }

  function throttleBroadcastFog() {
    if (S.fogBroadcastTimer) return;
    S.fogBroadcastTimer = setTimeout(function () { broadcastFog(); S.fogBroadcastTimer = null; }, 80);
  }
  var _vpTimer = null;
  function throttleBroadcastViewport() {
    if (_vpTimer) return;
    _vpTimer = setTimeout(function () { broadcastViewport(); _vpTimer = null; }, 50);
  }
  var _fullTimer = null;
  function throttleBroadcastFull() {
    if (_fullTimer) return;
    _fullTimer = setTimeout(function () { broadcastFull(); _fullTimer = null; }, 80);
  }

  function layerToDTO(l) {
    return { id: l.id, name: l.name, dataURL: l.dataURL,
             x: l.x, y: l.y, w: l.w, h: l.h, sx: l.sx, sy: l.sy,
             opacity: l.opacity, visible: l.visible };
  }

  function groupToDTO(g) {
    return {
      id:      g.id,
      name:    g.name,
      visible: g.visible,
      fogURL:  g.fog.canvas.toDataURL('image/png'),
      layers:  g.layers.map(layerToDTO),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO IMPORT / EXPORT
  // ─────────────────────────────────────────────────────────────────────────
  function buildScenario() {
    return {
      version:       SCENARIO_VERSION,
      exported:      new Date().toISOString(),
      world:         { w: S.world.w, h: S.world.h },
      vp:            { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom },
      activeGroupId: S.activeGroupId,
      groups:        S.groups.map(groupToDTO),
      checkpoints:   S.checkpoints.map(function (cp) {
        return { id: cp.id, name: cp.name, vp: { x: cp.vp.x, y: cp.vp.y, zoom: cp.vp.zoom } };
      }),
    };
  }

  function exportScenario() {
    var json = JSON.stringify(buildScenario(), null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    var ts  = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    a.download = 'dnd-scenario-' + ts + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Scenario exported');
  }

  function buildLayerFromDTO(dto, img) {
    return {
      id:      dto.id,
      name:    dto.name,
      dataURL: dto.dataURL,
      img:     img,
      x: dto.x != null ? dto.x : 0,
      y: dto.y != null ? dto.y : 0,
      w: dto.w || img.naturalWidth,
      h: dto.h || img.naturalHeight,
      sx: dto.sx != null ? dto.sx : (dto.scaleX != null ? dto.scaleX : 1),
      sy: dto.sy != null ? dto.sy : (dto.scaleY != null ? dto.scaleY : 1),
      opacity: dto.opacity != null ? dto.opacity : 1,
      visible: dto.visible !== false,
    };
  }

  function loadScenario(data) {
    var w = (data.world && data.world.w  != null) ? data.world.w  :
            (data.world && data.world.width != null) ? data.world.width : S.world.w;
    var h = (data.world && data.world.h  != null) ? data.world.h  :
            (data.world && data.world.height != null) ? data.world.height : S.world.h;
    S.world.w = w; S.world.h = h;

    if (data.vp) { S.vp.x = data.vp.x || 0; S.vp.y = data.vp.y || 0; S.vp.zoom = data.vp.zoom || 1; }

    S.checkpoints = (data.checkpoints || []).map(function (cp) {
      return {
        id:   cp.id || ('cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        name: cp.name || 'Checkpoint',
        vp:   { x: (cp.vp && cp.vp.x) || 0, y: (cp.vp && cp.vp.y) || 0, zoom: (cp.vp && cp.vp.zoom) || 1 },
      };
    });

    var groupDTOs = data.groups;

    if (groupDTOs && groupDTOs.length > 0) {
      // ── v3 format ────────────────────────────────────────────────────────
      S.groups        = [];
      S.activeGroupId = data.activeGroupId || groupDTOs[0].id;
      var pendingGroups = groupDTOs.length;

      groupDTOs.forEach(function (gdto) {
        var fogCanvas = document.createElement('canvas');
        fogCanvas.width  = w; fogCanvas.height = h;
        var fogCtx = fogCanvas.getContext('2d');
        fogCtx.fillStyle = '#000';
        fogCtx.fillRect(0, 0, w, h);

        var g = {
          id:      gdto.id,
          name:    gdto.name || 'Group',
          visible: gdto.visible !== false,
          fog:     { canvas: fogCanvas, ctx: fogCtx },
          layers:  [],
        };
        S.groups.push(g);

        if (gdto.fogURL) {
          var fi = new Image();
          fi.onload = (function (fc, fctx) {
            return function () { fctx.clearRect(0, 0, w, h); fctx.drawImage(fc, 0, 0); };
          }(fi, fogCtx));
          fi.src = gdto.fogURL;
        }

        var dtos = gdto.layers || [];
        if (dtos.length === 0) {
          pendingGroups--;
          if (pendingGroups === 0) finishLoad();
          return;
        }

        g.layers = new Array(dtos.length).fill(null);
        var pendingLayers = dtos.length;

        dtos.forEach(function (dto, idx) {
          var img = new Image();
          img.onload = (function (d, i, grp) {
            return function () {
              grp.layers[i] = buildLayerFromDTO(d, this);
              pendingLayers--;
              if (pendingLayers === 0) {
                grp.layers = grp.layers.filter(Boolean);
                pendingGroups--;
                if (pendingGroups === 0) finishLoad();
              }
            };
          }(dto, idx, g));
          img.onerror = (function (d, grp) {
            return function () {
              console.warn('Failed to load layer "' + d.name + '" in group "' + grp.name + '"');
              pendingLayers--;
              if (pendingLayers === 0) {
                grp.layers = grp.layers.filter(Boolean);
                pendingGroups--;
                if (pendingGroups === 0) finishLoad();
              }
            };
          }(dto, g));
          img.src = dto.dataURL;
        });
      });

    } else {
      // ── v2 backward-compat: wrap in a single default group ───────────────
      var fogCanvas = document.createElement('canvas');
      fogCanvas.width  = w; fogCanvas.height = h;
      var fogCtx = fogCanvas.getContext('2d');
      fogCtx.fillStyle = '#000';
      fogCtx.fillRect(0, 0, w, h);

      var dg = {
        id:      'g_migrated_' + Date.now(),
        name:    'Surface',
        visible: true,
        fog:     { canvas: fogCanvas, ctx: fogCtx },
        layers:  [],
      };
      S.groups        = [dg];
      S.activeGroupId = dg.id;

      var fogURL = data.fogURL || data.fog;
      if (fogURL) {
        var fi = new Image();
        fi.onload = (function (fc, fctx) {
          return function () { fctx.clearRect(0, 0, w, h); fctx.drawImage(fc, 0, 0); };
        }(fi, fogCtx));
        fi.src = fogURL;
      }

      var dtos = data.layers || [];
      if (dtos.length === 0) { finishLoad(); return; }

      dg.layers = new Array(dtos.length).fill(null);
      var loaded = 0;

      dtos.forEach(function (dto, idx) {
        var img = new Image();
        img.onload = (function (d, i) {
          return function () {
            dg.layers[i] = buildLayerFromDTO(d, this);
            loaded++;
            if (loaded === dtos.length) { dg.layers = dg.layers.filter(Boolean); finishLoad(); }
          };
        }(dto, idx));
        img.onerror = (function (d) {
          return function () {
            console.warn('Failed to load layer "' + d.name + '"');
            loaded++;
            if (loaded === dtos.length) { dg.layers = dg.layers.filter(Boolean); finishLoad(); }
          };
        }(dto));
        img.src = dto.dataURL;
      });
    }

    function finishLoad() {
      if (!S.groups.find(function (g) { return g.id === S.activeGroupId; })) {
        S.activeGroupId = S.groups[0] ? S.groups[0].id : null;
      }
      document.getElementById('world-w').value = w;
      document.getElementById('world-h').value = h;
      rebuildGroupTabs();
      rebuildLayerPanel();
      rebuildCheckpointPanel();
      broadcastFull();
      toast('Scenario loaded');
    }
  }

  function clearScenario() {
    if (!confirm('Clear all groups, layers, checkpoints and reset fog? This cannot be undone.')) return;
    var dg        = makeGroup('Surface');
    S.groups        = [dg];
    S.activeGroupId = dg.id;
    S.checkpoints   = [];
    S.world         = { w: 1920, h: 1080 };
    S.vp            = { x: 0, y: 0, zoom: 1 };
    S.selectedId    = null;
    document.getElementById('world-w').value = S.world.w;
    document.getElementById('world-h').value = S.world.h;
    rebuildGroupTabs();
    rebuildLayerPanel();
    rebuildCheckpointPanel();
    fitView();
    broadcastFull();
    try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_KEY_V2); } catch (_) {}
    toast('Scenario cleared');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOCAL STORAGE
  // ─────────────────────────────────────────────────────────────────────────
  var SCENARIO_VERSION = 3;
  var LS_KEY    = 'dnd-fog-v3';
  var LS_KEY_V2 = 'dnd-fog-v2';

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
      var raw = localStorage.getItem(LS_KEY) || localStorage.getItem(LS_KEY_V2);
      if (raw) {
        loadScenario(JSON.parse(raw));
        return;
      }
    } catch (e) {
      console.warn('localStorage load failed:', e);
    }
    fitView();
    rebuildGroupTabs();
    rebuildLayerPanel();
    rebuildCheckpointPanel();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYER WINDOW
  // ─────────────────────────────────────────────────────────────────────────
  function openPlayerView() {
    var url = new URL('player.html', window.location.href).href;
    var win = window.open(url, 'dnd-fog-player',
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes');
    if (!win) alert('Could not open player window. Please allow pop-ups for this page.');
    else toast('Player window opened');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI EVENT BINDINGS
  // ─────────────────────────────────────────────────────────────────────────
  function bindUIEvents() {
    document.getElementById('btn-fit').addEventListener('click', fitView);
    document.getElementById('btn-player').addEventListener('click', openPlayerView);
    document.getElementById('btn-import').addEventListener('click', function () { document.getElementById('file-scenario').click(); });
    document.getElementById('btn-export').addEventListener('click', exportScenario);
    document.getElementById('btn-clear').addEventListener('click', clearScenario);

    document.getElementById('file-img').addEventListener('change', function (e) {
      processImageFiles(e.target.files);
      e.target.value = '';
    });
    document.getElementById('file-scenario').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        try { loadScenario(JSON.parse(ev.target.result)); }
        catch (err) { alert('Could not parse scenario: ' + err.message); }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    document.getElementById('btn-add-group').addEventListener('click', addGroup);
    document.getElementById('btn-add-layer').addEventListener('click', function () { document.getElementById('file-img').click(); });

    document.querySelectorAll('.tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tool-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        S.tool = btn.dataset.tool;
        updateCursor();
      });
    });

    var brushSlider = document.getElementById('brush-size');
    var brushVal    = document.getElementById('brush-val');
    brushSlider.addEventListener('input', function () {
      S.brushSize = parseInt(brushSlider.value);
      brushVal.textContent = S.brushSize + ' px';
    });

    document.getElementById('btn-reveal-all').addEventListener('click', revealAll);
    document.getElementById('btn-hide-all').addEventListener('click', hideAll);

    document.getElementById('btn-apply-world').addEventListener('click', function () {
      var w = parseInt(document.getElementById('world-w').value);
      var h = parseInt(document.getElementById('world-h').value);
      if (w >= 100 && h >= 100) applyWorldSize(w, h);
    });

    document.getElementById('btn-save-cp').addEventListener('click', saveCheckpoint);

    window.addEventListener('keydown', function (e) {
      if (e.target.isContentEditable || e.target.tagName === 'INPUT') return;
      var map = { r: 'reveal', h: 'hide', p: 'pan', t: 'transform' };
      if (map[e.key.toLowerCase()]) {
        document.querySelectorAll('.tool-btn').forEach(function (b) { b.classList.remove('active'); });
        var btn = document.querySelector('.tool-btn[data-tool="' + map[e.key.toLowerCase()] + '"]');
        if (btn) btn.classList.add('active');
        S.tool = map[e.key.toLowerCase()];
        updateCursor();
      }
      if (e.key === 'f' || e.key === 'F') fitView();
      if (e.code === 'Space' && !e.repeat) {
        canvas.style.cursor = 'grab';
        canvas.dataset.spaceHeld = '1';
      }
    });
    window.addEventListener('keyup', function (e) {
      if (e.code === 'Space') {
        delete canvas.dataset.spaceHeld;
        updateCursor();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOAST
  // ─────────────────────────────────────────────────────────────────────────
  var _toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2500);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOOT
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
