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
    groups: [],           // array of { id, name, visible, fog:{canvas,ctx}, overlay:{canvas,ctx}, layers[] }
    activeGroupId: null,  // id of the group currently being edited by the DM
    playerGroupId: null,  // id of the group players see (may differ from activeGroupId)
    checkpoints: [],      // array of { id, name, vp:{x,y,zoom} }
    fogSession: { active: false, snapshot: null, groupId: null }, // staged fog painting
    vp: { x: 0, y: 0, zoom: 1 },
    world: { w: 1920, h: 1080 },
    tool: 'reveal',       // reveal | hide | pan | transform | texture
    brushSize: 50,
    textureBrush: 'scorched', // scorched | slime | water | beer | fire | earth | cracks | erase
    minimapVisible: true,
    isDrawing: false,
    isPanning: false,
    panStart: null, vpStart: null,
    cursorWorld: null,
    lastFogPt: null,
    selectedId: null,
    isDraggingLayer: false,
    dragStart: null,
    bc: null,
    paused: false,        // when true, broadcasts to player are suspended
    pausedVp: null,       // snapshot of viewport at time of pause (player keeps seeing this)
    saveTimer: null,
    fogBroadcastTimer: null,
    playerCamera: null, // { w, h } – player canvas dimensions reported via PLAYER_VIEWPORT
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
    S.playerGroupId = dg.id;

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

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width  = S.world.w;
    overlayCanvas.height = S.world.h;
    // Overlay starts fully transparent – no fill needed

    return {
      id:      'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name:    name || 'Group',
      visible: true,
      fog:     { canvas: fogCanvas, ctx: fogCtx },
      overlay: { canvas: overlayCanvas, ctx: overlayCanvas.getContext('2d') },
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
    if (S.playerGroupId === id) S.playerGroupId = S.groups[0].id;
    rebuildGroupTabs();
    rebuildLayerPanel();
    broadcastFull();
    scheduleSave();
  }

  function switchGroup(id) {
    if (S.fogSession.active) commitFogSession();
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

      const pinBtn = document.createElement('button');
      pinBtn.className = 'gt-pin' + (g.id === S.playerGroupId ? ' active' : '');
      pinBtn.title = g.id === S.playerGroupId ? 'Players are watching this group' : 'Set as player view';
      pinBtn.textContent = '\uD83D\uDCFA'; // 📺

      const delBtn = document.createElement('button');
      delBtn.className = 'gt-del';
      delBtn.title = 'Delete group';
      delBtn.textContent = '\u2715';

      div.appendChild(visBtn);
      div.appendChild(nameEl);
      div.appendChild(pinBtn);
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

      pinBtn.addEventListener('click', e => {
        e.stopPropagation();
        setPlayerGroup(g.id);
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
    if (S.fogSession.active) commitFogSession();
    const fc = ag().fog.ctx;
    fc.save();
    fc.globalCompositeOperation = 'destination-out';
    fc.fillRect(0, 0, S.world.w, S.world.h);
    fc.restore();
    afterFogChange();
  }

  function hideAll() {
    if (S.fogSession.active) commitFogSession();
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
  // FOG SESSION (staged painting – strokes are visible to DM but not broadcast
  // to players until the DM explicitly commits them)
  // ─────────────────────────────────────────────────────────────────────────
  function startFogSession() {
    if (S.fogSession.active) return;
    var g = ag();
    if (!g) return;
    var snap = document.createElement('canvas');
    snap.width  = g.fog.canvas.width;
    snap.height = g.fog.canvas.height;
    snap.getContext('2d').drawImage(g.fog.canvas, 0, 0);
    S.fogSession.active   = true;
    S.fogSession.snapshot = snap;
    S.fogSession.groupId  = g.id;
    showFogSessionBar();
  }

  function commitFogSession() {
    if (!S.fogSession.active) return;
    S.fogSession.active   = false;
    S.fogSession.snapshot = null;
    S.fogSession.groupId  = null;
    hideFogSessionBar();
    broadcastFog();
    scheduleSave();
  }

  function revertFogSession() {
    if (!S.fogSession.active) return;
    var g = S.groups.find(function (x) { return x.id === S.fogSession.groupId; });
    if (g && S.fogSession.snapshot) {
      g.fog.ctx.clearRect(0, 0, g.fog.canvas.width, g.fog.canvas.height);
      g.fog.ctx.drawImage(S.fogSession.snapshot, 0, 0);
    }
    S.fogSession.active   = false;
    S.fogSession.snapshot = null;
    S.fogSession.groupId  = null;
    hideFogSessionBar();
  }

  function showFogSessionBar() {
    var bar = document.getElementById('fog-session-bar');
    if (bar) bar.classList.add('active');
  }

  function hideFogSessionBar() {
    var bar = document.getElementById('fog-session-bar');
    if (bar) bar.classList.remove('active');
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

      if (g.overlay) {
        const oldOv = document.createElement('canvas');
        oldOv.width  = g.overlay.canvas.width;
        oldOv.height = g.overlay.canvas.height;
        oldOv.getContext('2d').drawImage(g.overlay.canvas, 0, 0);
        g.overlay.canvas.width  = w;
        g.overlay.canvas.height = h;
        g.overlay.ctx.drawImage(oldOv, 0, 0, w, h);
      }
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
  // HATCHED PATTERN  (for out-of-bounds / undeveloped areas)
  // ─────────────────────────────────────────────────────────────────────────
  var _hatchPattern = null;
  function getHatchPattern(targetCtx) {
    if (_hatchPattern) return _hatchPattern;
    var pc = document.createElement('canvas');
    pc.width = 16; pc.height = 16;
    var pctx = pc.getContext('2d');
    pctx.strokeStyle = 'rgba(255,255,255,0.08)';
    pctx.lineWidth = 1;
    // diagonal lines
    pctx.beginPath();
    pctx.moveTo(0, 16); pctx.lineTo(16, 0);
    pctx.moveTo(-4, 4); pctx.lineTo(4, -4);
    pctx.moveTo(12, 20); pctx.lineTo(20, 12);
    pctx.stroke();
    _hatchPattern = targetCtx.createPattern(pc, 'repeat');
    return _hatchPattern;
  }

  /** Draw hatched fog in the visible area outside the world rectangle (operates in screen space). */
  function drawOutOfBoundsHatch(targetCtx, worldW, worldH, vpX, vpY, zoom, canvasW, canvasH) {
    targetCtx.save();

    // Clip to everything outside the world rect using even-odd rule
    targetCtx.beginPath();
    targetCtx.rect(0, 0, canvasW, canvasH);                         // full canvas (CW)
    // World rect in screen space (CCW = subtract)
    var wx1 = vpX;
    var wy1 = vpY;
    var wx2 = vpX + worldW * zoom;
    var wy2 = vpY + worldH * zoom;
    targetCtx.moveTo(wx1, wy1);
    targetCtx.lineTo(wx1, wy2);
    targetCtx.lineTo(wx2, wy2);
    targetCtx.lineTo(wx2, wy1);
    targetCtx.closePath();
    targetCtx.clip('evenodd');

    // Dark background fill
    targetCtx.fillStyle = '#0a0a18';
    targetCtx.fillRect(0, 0, canvasW, canvasH);
    // Hatching overlay
    targetCtx.fillStyle = getHatchPattern(targetCtx);
    targetCtx.fillRect(0, 0, canvasW, canvasH);

    targetCtx.restore();
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
      const gOpacity = (parseInt(document.getElementById('grid-opacity').value) || 7) / 100;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,' + gOpacity + ')';
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

    // Texture overlay (beneath fog, visible to both DM and players)
    if (g.overlay && g.overlay.canvas) {
      ctx.drawImage(g.overlay.canvas, 0, 0);
    }

    // Fog – 65 % opacity so DM can see the map beneath
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.drawImage(g.fog.canvas, 0, 0);
    ctx.restore();

    // Hatched out-of-bounds area (drawn in screen space)
    ctx.restore(); // exit world transform
    drawOutOfBoundsHatch(ctx, S.world.w, S.world.h, S.vp.x, S.vp.y, S.vp.zoom, canvas.width, canvas.height);

    // Re-enter world transform for player camera, checkpoints, and brush cursor
    ctx.save();
    ctx.translate(S.vp.x, S.vp.y);
    ctx.scale(S.vp.zoom, S.vp.zoom);

    // Player camera indicator (drawn in world space)
    if (S.playerCamera) {
      var pcW = S.playerCamera.w / S.vp.zoom;
      var pcH = S.playerCamera.h / S.vp.zoom;
      var pcX = (-S.vp.x) / S.vp.zoom;
      var pcY = (-S.vp.y) / S.vp.zoom;
      ctx.save();
      ctx.strokeStyle = 'rgba(0, 180, 255, 0.7)';
      ctx.lineWidth = 2 / S.vp.zoom;
      ctx.setLineDash([8 / S.vp.zoom, 4 / S.vp.zoom]);
      ctx.strokeRect(pcX, pcY, pcW, pcH);
      ctx.setLineDash([]);
      // Label
      ctx.fillStyle = 'rgba(0, 180, 255, 0.85)';
      ctx.font = 'bold ' + Math.max(10, 12 / S.vp.zoom) + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('📺 Player View', pcX + 4 / S.vp.zoom, pcY - 3 / S.vp.zoom);
      ctx.restore();
    }

    // Checkpoint markers
    renderCheckpointMarkers();

    // Brush cursor
    if (S.cursorWorld && (S.tool === 'reveal' || S.tool === 'hide' || S.tool === 'texture')) {
      ctx.save();
      ctx.strokeStyle = S.tool === 'reveal'
        ? 'rgba(255,200,40,0.85)'
        : S.tool === 'hide'
        ? 'rgba(80,80,255,0.85)'
        : (TEXTURE_CURSOR_COLORS[S.textureBrush] || 'rgba(200,100,50,0.85)');
      ctx.lineWidth = 2 / S.vp.zoom;
      ctx.setLineDash([5 / S.vp.zoom, 5 / S.vp.zoom]);
      ctx.beginPath();
      ctx.arc(S.cursorWorld.x, S.cursorWorld.y, S.brushSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // Paused indicator
    if (S.paused) {
      ctx.save();
      ctx.fillStyle = 'rgba(233, 69, 96, 0.15)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = 'rgba(233, 69, 96, 0.9)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('⏸ PAUSED', canvas.width - 12, 10);
      ctx.restore();
    }

    renderMinimap();
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
      startFogSession();   // snapshot before first stroke of this session
      S.isDrawing = true;
      S.lastFogPt = w;
      applyFog(w.x, w.y, S.tool);
      return;
    }

    if (S.tool === 'texture') {
      S.isDrawing = true;
      S.lastFogPt = w;
      applyTexture(w.x, w.y);
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
      // Do NOT broadcast during a session – player sees changes only after commit
      return;
    }

    if (S.isDrawing && S.tool === 'texture') {
      if (S.lastFogPt) interpolateTexture(S.lastFogPt.x, S.lastFogPt.y, w.x, w.y);
      S.lastFogPt = w;
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
    const wasDrag = S.isDraggingLayer;
    const wasTex  = S.isDrawing && S.tool === 'texture';
    S.isDrawing       = false;
    S.isPanning       = false;
    S.isDraggingLayer = false;
    S.lastFogPt       = null;
    updateCursor();
    // Fog changes are held in session until the DM clicks "Send to players"
    if (wasDrag) { broadcastFull();    scheduleSave(); }
    if (wasTex)  { broadcastOverlay(); scheduleSave(); }
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
  var _tDist   = 0;
  var _tCenter = null;   // previous two-finger center in client coords

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      _tCenter = null;
      var t = e.touches[0];
      onMouseDown({ clientX: t.clientX, clientY: t.clientY,
        button: S.tool === 'pan' ? 1 : 0, altKey: false, preventDefault: function () {} });
    } else if (e.touches.length === 2) {
      // Cancel any ongoing single-touch action before starting pinch
      S.isDrawing       = false;
      S.isPanning       = false;
      S.isDraggingLayer = false;
      S.lastFogPt       = null;
      updateCursor();
      _tDist   = tDist(e.touches);
      _tCenter = tCenter(e.touches);
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      var t = e.touches[0];
      onMouseMove({ clientX: t.clientX, clientY: t.clientY });
    } else if (e.touches.length === 2) {
      var nd  = tDist(e.touches);
      var nc  = tCenter(e.touches);
      var newS = getCanvasXY({ clientX: nc.x, clientY: nc.y });

      // Use the previous center's world point as the zoom/pan anchor so that
      // the same world point stays under the new center (handles simultaneous pan + zoom).
      var oldS = getCanvasXY({ clientX: _tCenter.x, clientY: _tCenter.y });
      var w    = screenToWorld(oldS.x, oldS.y);

      var f  = nd / _tDist;
      var nz = Math.max(0.04, Math.min(25, S.vp.zoom * f));
      S.vp.zoom = nz;
      S.vp.x    = newS.x - w.x * nz;
      S.vp.y    = newS.y - w.y * nz;

      _tDist   = nd;
      _tCenter = nc;
      throttleBroadcastViewport();
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      _tCenter = null;
      onMouseUp();
    } else if (e.touches.length === 1) {
      // One finger lifted while two were down – stop all actions cleanly.
      // The remaining finger will only act on the next intentional touchstart.
      S.isDrawing       = false;
      S.isPanning       = false;
      S.isDraggingLayer = false;
      S.lastFogPt       = null;
      _tCenter          = null;
      updateCursor();
    }
  }
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
    var map = { reveal: 'crosshair', hide: 'crosshair', pan: 'grab', transform: 'default', texture: 'crosshair' };
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
  // SAMPLE MAP GENERATORS
  // Procedurally draw built-in placeholder maps at 960×540 and add as layers.
  // ─────────────────────────────────────────────────────────────────────────
  var SAMPLE_MAPS = {
    dungeon_room: { label: 'Dungeon Room', fn: drawSampleDungeon  },
    forest:       { label: 'Forest Clearing', fn: drawSampleForest },
    tavern:       { label: 'Tavern',          fn: drawSampleTavern },
  };

  function addSampleLayer(type) {
    var sample = SAMPLE_MAPS[type];
    if (!sample) return;
    var c = document.createElement('canvas');
    c.width = 960; c.height = 540;
    sample.fn(c.getContext('2d'), c.width, c.height);
    var dataURL = c.toDataURL('image/png');
    var img = new Image();
    img.onload = function () {
      var layer = makeLayer(sample.label, dataURL, img);
      if (ag().layers.length === 0) {
        layer.sx = S.world.w / layer.w;
        layer.sy = S.world.h / layer.h;
      }
      addLayer(layer);
      toast('Sample "' + sample.label + '" added');
    };
    img.src = dataURL;
  }

  // ── Dungeon Room ────────────────────────────────────────────────────────────
  function drawSampleDungeon(ctx, W, H) {
    // Background (dark stone)
    ctx.fillStyle = '#181520';
    ctx.fillRect(0, 0, W, H);

    // Stone tile grid on background
    ctx.strokeStyle = '#0e0c14';
    ctx.lineWidth = 1;
    var ts = 48;
    for (var x = 0; x <= W; x += ts) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = 0; y <= H; y += ts) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Room floor
    var rx = 160, ry = 90, rw = W - 320, rh = H - 180;
    ctx.fillStyle = '#3c2e1c';
    ctx.fillRect(rx, ry, rw, rh);

    // Floor tile grid inside room
    ctx.strokeStyle = '#2a2010';
    ctx.lineWidth = 1;
    for (var x = rx; x <= rx + rw; x += ts) { ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x, ry + rh); ctx.stroke(); }
    for (var y = ry; y <= ry + rh; y += ts) { ctx.beginPath(); ctx.moveTo(rx, y); ctx.lineTo(rx + rw, y); ctx.stroke(); }

    // Walls
    var wt = 28;
    ctx.fillStyle = '#100e18';
    ctx.fillRect(rx - wt, ry - wt, rw + wt * 2, wt);       // top
    ctx.fillRect(rx - wt, ry + rh, rw + wt * 2, wt);       // bottom
    ctx.fillRect(rx - wt, ry, wt, rh);                      // left
    ctx.fillRect(rx + rw, ry, wt, rh);                      // right

    // Wall detail: crack marks
    ctx.strokeStyle = '#1e1a28';
    ctx.lineWidth = 1;
    function crack(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    crack(rx - wt + 5, ry - wt + 8, rx - wt + 12, ry - 2);
    crack(rx + rw + 8, ry + 40, rx + rw + 20, ry + 55);
    crack(rx + rw * 0.3, ry - wt + 3, rx + rw * 0.32, ry - 1);
    crack(rx - wt + 5, ry + rh + 14, rx - wt + 14, ry + rh + wt - 2);

    // Door openings
    var dw = 56;
    ctx.fillStyle = '#3c2e1c';
    ctx.fillRect(rx + rw / 2 - dw / 2, ry - wt, dw, wt);         // top
    ctx.fillRect(rx + rw / 2 - dw / 2, ry + rh, dw, wt);         // bottom
    ctx.fillRect(rx - wt, ry + rh / 2 - dw / 2, wt, dw);         // left
    ctx.fillRect(rx + rw, ry + rh / 2 - dw / 2, wt, dw);         // right

    // Pillars at inner corners
    var pr = 13;
    [[rx + 55, ry + 50], [rx + rw - 55, ry + 50],
     [rx + 55, ry + rh - 50], [rx + rw - 55, ry + rh - 50]].forEach(function (p) {
      ctx.fillStyle = '#100e18';
      ctx.beginPath(); ctx.arc(p[0], p[1], pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3c2e1c'; ctx.lineWidth = 2; ctx.stroke();
    });

    // Room border highlight
    ctx.strokeStyle = '#5a4830';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // Vignette
    var vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, W * 0.6);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Forest Clearing ─────────────────────────────────────────────────────────
  function drawSampleForest(ctx, W, H) {
    // Base ground
    ctx.fillStyle = '#2a4a1a';
    ctx.fillRect(0, 0, W, H);

    // Grass variation patches; deterministic LCG so the map looks the same every time
    var seed = 0;
    // nextSeed: Linear Congruential Generator – glibc constants, gives repeatable results
    function nextSeed() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
    for (var gi = 0; gi < 600; gi++) {
      nextSeed(); var px = nextSeed() % W;
      nextSeed(); var py = nextSeed() % H;
      var pr2 = 15 + (nextSeed() % 35);
      var dark = (nextSeed() % 2 === 0);
      ctx.fillStyle = dark ? 'rgba(20,40,10,0.3)' : 'rgba(60,100,30,0.25)';
      ctx.beginPath(); ctx.arc(px, py, pr2, 0, Math.PI * 2); ctx.fill();
    }

    // Central clearing (lighter open area)
    var cx = W / 2, cy = H / 2, clearR = 185;
    var cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, clearR);
    cg.addColorStop(0, '#5a8c38');
    cg.addColorStop(0.65, '#3a6428');
    cg.addColorStop(1, 'rgba(42,74,26,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx, cy, clearR, 0, Math.PI * 2); ctx.fill();

    // Dirt path (left→right)
    ctx.save();
    ctx.strokeStyle = '#7a6038';
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, H * 0.5);
    ctx.bezierCurveTo(W * 0.22, H * 0.46, W * 0.38, H * 0.52, cx, cy);
    ctx.bezierCurveTo(W * 0.62, H * 0.48, W * 0.78, H * 0.46, W, H * 0.44);
    ctx.stroke();
    ctx.strokeStyle = '#9a7848';
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.restore();

    // Trees (placed around the clearing edge)
    var treeData = [];
    for (var ti = 0; ti < 55; ti++) {
      var ang = (ti / 55) * Math.PI * 2 + (nextSeed() % 100) / 500;
      var dist = clearR + 35 + (nextSeed() % 140);
      var tx = cx + Math.cos(ang) * dist;
      var ty = cy + Math.sin(ang) * dist * 0.72;
      if (tx < 12 || tx > W - 12 || ty < 12 || ty > H - 12) continue;
      treeData.push([tx, ty, 13 + (nextSeed() % 11)]);
    }
    // Sort by y for depth
    treeData.sort(function (a, b) { return a[1] - b[1]; });
    treeData.forEach(function (t) {
      var tx = t[0], ty = t[1], tr = t[2];
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(tx + 3, ty + tr * 0.55, tr * 0.85, tr * 0.32, 0, 0, Math.PI * 2); ctx.fill();
      // Trunk
      ctx.fillStyle = '#5a3e20';
      ctx.fillRect(tx - 3, ty, 6, tr * 0.55);
      // Canopy
      var tcg = ctx.createRadialGradient(tx, ty - tr * 0.35, 0, tx, ty - tr * 0.35, tr * 1.15);
      tcg.addColorStop(0, '#4a8c28');
      tcg.addColorStop(0.55, '#2a5c18');
      tcg.addColorStop(1, '#1a3c0e');
      ctx.fillStyle = tcg;
      ctx.beginPath(); ctx.arc(tx, ty - tr * 0.35, tr * 1.1, 0, Math.PI * 2); ctx.fill();
    });

    // Campfire at clearing centre
    ctx.fillStyle = '#5a3010';
    ctx.beginPath(); ctx.arc(cx, cy + 10, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#cc4400';
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath(); ctx.arc(cx, cy - 4, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffee88';
    ctx.beginPath(); ctx.arc(cx, cy - 7, 3, 0, Math.PI * 2); ctx.fill();
  }

  // ── Tavern ──────────────────────────────────────────────────────────────────
  function drawSampleTavern(ctx, W, H) {
    // Wooden plank floor
    var plankH = 38;
    for (var py = 0; py < H; py += plankH) {
      var row = Math.floor(py / plankH);
      ctx.fillStyle = row % 2 === 0 ? '#6b4420' : '#7a5030';
      ctx.fillRect(0, py, W, plankH);
      // Separator line
      ctx.strokeStyle = '#3a2008';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
      // Vertical grain (deterministic)
      ctx.strokeStyle = 'rgba(30,12,0,0.15)';
      for (var gi = 0; gi < 7; gi++) {
        var gx = (gi * 141 + row * 53) % W;
        ctx.beginPath(); ctx.moveTo(gx, py); ctx.lineTo(gx + (gi % 3) - 1, py + plankH); ctx.stroke();
      }
    }

    // Bar counter (left side)
    ctx.fillStyle = '#2a1006';
    ctx.fillRect(0, 60, 150, H - 120);
    ctx.fillStyle = '#4a2c10';
    ctx.fillRect(0, 60, 150, 18);          // counter top edge
    ctx.fillStyle = '#3a1a08';
    ctx.fillRect(130, 60, 4, H - 120);    // counter front edge
    ctx.fillStyle = '#5a3418';
    for (var sy = 90; sy < H - 120; sy += 40) {
      ctx.fillRect(10, sy, 110, 24);       // shelf / bottle rows
    }

    // Bar stools
    for (var si = 0; si < 6; si++) {
      var stoolY = 110 + si * Math.floor((H - 220) / 6) + 20;
      ctx.fillStyle = '#8b5e32';
      ctx.beginPath(); ctx.arc(178, stoolY, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#4a2e10'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Tables with chairs
    var tables = [
      [W * 0.44, H * 0.28], [W * 0.70, H * 0.28],
      [W * 0.44, H * 0.68], [W * 0.70, H * 0.68],
    ];
    tables.forEach(function (t) {
      var tx = t[0], ty = t[1];
      // Table surface
      ctx.fillStyle = '#5a3a18';
      ctx.fillRect(tx - 52, ty - 34, 104, 68);
      ctx.strokeStyle = '#2a1006'; ctx.lineWidth = 2;
      ctx.strokeRect(tx - 52, ty - 34, 104, 68);
      // Wood grain on table
      ctx.strokeStyle = 'rgba(30,10,0,0.2)';
      ctx.lineWidth = 1;
      for (var gi = 0; gi < 4; gi++) {
        ctx.beginPath();
        ctx.moveTo(tx - 52 + gi * 26, ty - 34);
        ctx.lineTo(tx - 50 + gi * 26, ty + 34);
        ctx.stroke();
      }
      // Chairs (4 sides)
      [[0, -52], [0, 52], [-66, 0], [66, 0]].forEach(function (o) {
        ctx.fillStyle = '#7a5028';
        ctx.beginPath(); ctx.arc(tx + o[0], ty + o[1], 13, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#2a1006'; ctx.lineWidth = 1.5; ctx.stroke();
      });
      // Tankard / mug on table
      ctx.fillStyle = '#c0902a';
      ctx.fillRect(tx - 8, ty - 12, 16, 20);
      ctx.strokeStyle = '#8a6010'; ctx.lineWidth = 1; ctx.strokeRect(tx - 8, ty - 12, 16, 20);
    });

    // Fireplace (right wall)
    ctx.fillStyle = '#1a0e06';
    ctx.fillRect(W - 110, 70, 100, 140);
    ctx.fillStyle = '#8b5e20';
    ctx.fillRect(W - 100, 70, 80, 14);   // mantle
    ctx.fillStyle = '#381808';
    ctx.fillRect(W - 96, 90, 72, 110);   // hearth opening
    // Fire glow
    var fireGrad = ctx.createRadialGradient(W - 60, 170, 0, W - 60, 170, 50);
    fireGrad.addColorStop(0, 'rgba(255,200,50,0.9)');
    fireGrad.addColorStop(0.4, 'rgba(220,80,10,0.6)');
    fireGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fireGrad;
    ctx.fillRect(W - 110, 90, 100, 140);
    // Flames
    ctx.fillStyle = '#ff8800';
    ctx.beginPath(); ctx.moveTo(W - 72, 180); ctx.bezierCurveTo(W - 85, 155, W - 85, 130, W - 60, 100); ctx.bezierCurveTo(W - 35, 130, W - 35, 155, W - 48, 180); ctx.fill();
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath(); ctx.arc(W - 60, 148, 14, 0, Math.PI * 2); ctx.fill();

    // Door (bottom centre)
    ctx.fillStyle = '#2a1206';
    ctx.fillRect(W / 2 - 35, H - 50, 70, 50);
    ctx.strokeStyle = '#8b5e20'; ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - 35, H - 50, 70, 50);
    // Door handle
    ctx.fillStyle = '#c0a030';
    ctx.beginPath(); ctx.arc(W / 2 + 20, H - 25, 5, 0, Math.PI * 2); ctx.fill();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYER GROUP – which group the players' screen shows
  // ─────────────────────────────────────────────────────────────────────────
  function setPlayerGroup(id) {
    var g = S.groups.find(function (x) { return x.id === id; });
    if (!g) return;
    S.playerGroupId = id;
    rebuildGroupTabs();
    broadcastFull();
    scheduleSave();
    toast('Player view \u2192 "' + g.name + '"');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEXTURE PAINT  (overlay canvas per group, visible to DM and players)
  // ─────────────────────────────────────────────────────────────────────────
  var TEXTURE_CURSOR_COLORS = {
    scorched: 'rgba(80, 40, 10, 0.9)',
    slime:    'rgba(80, 200, 40, 0.9)',
    water:    'rgba(60, 150, 230, 0.9)',
    beer:     'rgba(220, 160, 30, 0.9)',
    fire:     'rgba(255, 100, 0, 0.9)',
    earth:    'rgba(130, 85, 40, 0.9)',
    cracks:   'rgba(40, 30, 20, 0.9)',
    erase:    'rgba(230, 50, 80, 0.9)',
  };

  function applyTexture(wx, wy) {
    var g = ag();
    if (!g || !g.overlay) return;
    var oc = g.overlay.ctx;
    var r  = S.brushSize;
    if (S.textureBrush === 'erase') {
      oc.save();
      oc.globalCompositeOperation = 'destination-out';
      oc.beginPath();
      oc.arc(wx, wy, r, 0, Math.PI * 2);
      oc.fill();
      oc.restore();
      return;
    }
    stampTexture(oc, wx, wy, r, S.textureBrush);
  }

  function interpolateTexture(x1, y1, x2, y2) {
    var d = Math.hypot(x2 - x1, y2 - y1);
    var steps = Math.max(1, Math.ceil(d / (S.brushSize * 0.45)));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      applyTexture(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
  }

  function stampTexture(ctx, cx, cy, r, type) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    switch (type) {
      case 'scorched': drawTexScorched(ctx, cx, cy, r); break;
      case 'slime':    drawTexSlime(ctx, cx, cy, r);    break;
      case 'water':    drawTexWater(ctx, cx, cy, r);    break;
      case 'beer':     drawTexBeer(ctx, cx, cy, r);     break;
      case 'fire':     drawTexFire(ctx, cx, cy, r);     break;
      case 'earth':    drawTexEarth(ctx, cx, cy, r);    break;
      case 'cracks':   drawTexCracks(ctx, cx, cy, r);   break;
    }
    ctx.restore();
  }

  function drawTexScorched(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,    'rgba(50, 25, 8, 0.92)');
    g.addColorStop(0.55, 'rgba(25, 12, 3, 0.78)');
    g.addColorStop(1,    'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(8, 4, 1, 0.65)';
    for (var i = 0; i < 14; i++) {
      var a = (i / 14) * Math.PI * 2 + i * 0.41;
      var d = r * (0.15 + (i % 4) * 0.18);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * 0.07 + (i % 3) * r * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTexSlime(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx - r * 0.15, cy - r * 0.2, 0, cx, cy, r);
    g.addColorStop(0,   'rgba(140, 210, 50, 0.88)');
    g.addColorStop(0.6, 'rgba(70, 160, 20, 0.72)');
    g.addColorStop(1,   'rgba(30, 90, 5, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    var h = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.28, 0, cx - r * 0.1, cy - r * 0.1, r * 0.48);
    h.addColorStop(0, 'rgba(210, 255, 120, 0.45)');
    h.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = h;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  function drawTexWater(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,    'rgba(70, 155, 225, 0.72)');
    g.addColorStop(0.65, 'rgba(35, 95, 185, 0.55)');
    g.addColorStop(1,    'rgba(15, 55, 140, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.strokeStyle = 'rgba(180, 225, 255, 0.32)';
    ctx.lineWidth = Math.max(1, r * 0.045);
    for (var i = -2; i <= 2; i++) {
      var wy = cy + i * r * 0.22;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.72, wy);
      ctx.quadraticCurveTo(cx, wy - r * 0.1, cx + r * 0.72, wy);
      ctx.stroke();
    }
  }

  function drawTexBeer(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,   'rgba(210, 155, 35, 0.82)');
    g.addColorStop(0.6, 'rgba(165, 100, 18, 0.66)');
    g.addColorStop(1,   'rgba(100, 58, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(255, 252, 235, 0.52)';
    for (var i = 0; i < 10; i++) {
      var a = (i / 10) * Math.PI * 2 + i * 0.63;
      var d = r * (0.12 + (i % 3) * 0.22);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * 0.085 + (i % 3) * r * 0.03, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTexFire(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx, cy + r * 0.18, 0, cx, cy, r);
    g.addColorStop(0,    'rgba(255, 245, 55, 0.92)');
    g.addColorStop(0.3,  'rgba(255, 110, 0, 0.82)');
    g.addColorStop(0.65, 'rgba(200, 28, 0, 0.55)');
    g.addColorStop(1,    'rgba(60, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    var hg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.35);
    hg.addColorStop(0, 'rgba(255, 255, 200, 0.7)');
    hg.addColorStop(1, 'rgba(255, 255, 200, 0)');
    ctx.fillStyle = hg;
    ctx.fillRect(cx - r * 0.35, cy - r * 0.35, r * 0.7, r * 0.7);
  }

  function drawTexEarth(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,    'rgba(105, 68, 28, 0.88)');
    g.addColorStop(0.62, 'rgba(82, 52, 18, 0.72)');
    g.addColorStop(1,    'rgba(52, 30, 8, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(58, 38, 14, 0.62)';
    for (var i = 0; i < 12; i++) {
      var a = (i / 12) * Math.PI * 2 + i * 0.5;
      var d = r * (0.12 + (i % 4) * 0.17);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * 0.06 + (i % 3) * r * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTexCracks(ctx, cx, cy, r) {
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(18, 12, 8, 0.72)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.strokeStyle = 'rgba(12, 8, 5, 0.88)';
    ctx.lineWidth = Math.max(1.2, r * 0.038);
    var numCracks = Math.max(4, Math.floor(r / 15));
    for (var i = 0; i < numCracks; i++) {
      var a = (i / numCracks) * Math.PI * 2 + i * 0.45;
      var midX = cx + Math.cos(a + 0.3) * r * 0.38;
      var midY = cy + Math.sin(a + 0.3) * r * 0.38;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(midX, midY);
      ctx.lineTo(cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88);
      ctx.stroke();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MINIMAP  (rendered to a separate canvas element in the corner)
  // ─────────────────────────────────────────────────────────────────────────
  function renderMinimap() {
    if (!S.minimapVisible) return;
    var mc = document.getElementById('minimap-canvas');
    if (!mc) return;
    var mctx = mc.getContext('2d');
    var MW = mc.width, MH = mc.height;
    var scale = Math.min(MW / S.world.w, MH / S.world.h);
    var offX = (MW - S.world.w * scale) / 2;
    var offY = (MH - S.world.h * scale) / 2;

    mctx.clearRect(0, 0, MW, MH);
    mctx.fillStyle = '#02020a';
    mctx.fillRect(0, 0, MW, MH);

    var g = ag();
    if (!g) return;

    mctx.save();
    mctx.translate(offX, offY);
    mctx.scale(scale, scale);

    mctx.fillStyle = '#0d0d1e';
    mctx.fillRect(0, 0, S.world.w, S.world.h);

    for (var i = g.layers.length - 1; i >= 0; i--) {
      var l = g.layers[i];
      if (!l.visible || !l.img || !l.img.complete) continue;
      mctx.save();
      mctx.globalAlpha = l.opacity;
      mctx.drawImage(l.img, l.x, l.y, l.w * l.sx, l.h * l.sy);
      mctx.restore();
    }

    if (g.overlay && g.overlay.canvas) {
      mctx.drawImage(g.overlay.canvas, 0, 0);
    }

    mctx.save();
    mctx.globalAlpha = 0.8;
    mctx.drawImage(g.fog.canvas, 0, 0);
    mctx.restore();

    mctx.restore();

    // World border
    mctx.strokeStyle = 'rgba(80, 90, 130, 0.6)';
    mctx.lineWidth = 1;
    mctx.strokeRect(offX, offY, S.world.w * scale, S.world.h * scale);

    // DM viewport indicator (gold rectangle)
    var vpX = offX + (-S.vp.x / S.vp.zoom) * scale;
    var vpY = offY + (-S.vp.y / S.vp.zoom) * scale;
    var vpW = (canvas.width  / S.vp.zoom) * scale;
    var vpH = (canvas.height / S.vp.zoom) * scale;
    mctx.strokeStyle = 'rgba(245,166,35,0.88)';
    mctx.lineWidth = 1.5;
    mctx.strokeRect(vpX, vpY, vpW, vpH);

    // Player camera indicator (cyan rectangle)
    if (S.playerCamera) {
      var pcX = offX + (-S.vp.x / S.vp.zoom) * scale;
      var pcY = offY + (-S.vp.y / S.vp.zoom) * scale;
      var pcW = (S.playerCamera.w / S.vp.zoom) * scale;
      var pcH = (S.playerCamera.h / S.vp.zoom) * scale;
      mctx.strokeStyle = 'rgba(0, 180, 255, 0.85)';
      mctx.lineWidth = 1.5;
      mctx.setLineDash([3, 2]);
      mctx.strokeRect(pcX, pcY, pcW, pcH);
      mctx.setLineDash([]);
    }
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
  // PAUSE MODE – freeze the player view while DM edits freely
  // ─────────────────────────────────────────────────────────────────────────
  function togglePause() {
    S.paused = !S.paused;
    var btn = document.getElementById('btn-pause');
    if (S.paused) {
      S.pausedVp = { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom };
      if (btn) { btn.classList.add('active'); btn.textContent = '⏸ Paused'; }
      toast('Player view paused');
    } else {
      S.pausedVp = null;
      if (btn) { btn.classList.remove('active'); btn.textContent = '⏸ Pause'; }
      // Sync everything to player on unpause
      broadcastFull();
      toast('Player view resumed');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BROADCAST CHANNEL
  // ─────────────────────────────────────────────────────────────────────────
  function onBcMessage(e) {
    if (e.data.type === 'PLAYER_HELLO') {
      // Always respond to PLAYER_HELLO, even when paused (send paused snapshot)
      if (S.paused) {
        var wasPaused = true;
        S.paused = false;
        broadcastFull();
        S.paused = true;
        // Re-send paused viewport so player stays where they were
        if (S.pausedVp && S.bc) {
          S.bc.postMessage({ type: 'VP_UPDATE', payload: { vp: S.pausedVp } });
        }
      } else {
        broadcastFull();
      }
    }
    if (e.data.type === 'PLAYER_VIEWPORT') {
      S.playerCamera = { w: e.data.payload.w, h: e.data.payload.h };
    }
  }

  function broadcastFull() {
    if (!S.bc || S.paused) return;
    S.bc.postMessage({
      type: 'FULL_STATE',
      payload: {
        world:         { w: S.world.w, h: S.world.h },
        vp:            { x: S.vp.x, y: S.vp.y, zoom: S.vp.zoom },
        activeGroupId: S.playerGroupId || S.activeGroupId, // send playerGroupId; players render their pinned group
        groups:        S.groups.map(groupToDTO),
      },
    });
  }

  function broadcastFog() {
    if (!S.bc || S.paused) return;
    var g = ag();
    S.bc.postMessage({
      type: 'FOG_UPDATE',
      payload: { groupId: g.id, fogURL: g.fog.canvas.toDataURL('image/png') },
    });
  }

  function broadcastOverlay() {
    if (!S.bc || S.paused) return;
    var g = ag();
    if (!g || !g.overlay) return;
    S.bc.postMessage({
      type: 'OVERLAY_UPDATE',
      payload: { groupId: g.id, overlayURL: g.overlay.canvas.toDataURL('image/png') },
    });
  }

  function broadcastViewport() {
    if (!S.bc || S.paused) return;
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
      id:         g.id,
      name:       g.name,
      visible:    g.visible,
      fogURL:     g.fog.canvas.toDataURL('image/png'),
      overlayURL: g.overlay ? g.overlay.canvas.toDataURL('image/png') : null,
      layers:     g.layers.map(layerToDTO),
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
      playerGroupId: S.playerGroupId,
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

        // Create overlay canvas for this group
        var overlayCanvas = document.createElement('canvas');
        overlayCanvas.width = w; overlayCanvas.height = h;
        var overlayCtx = overlayCanvas.getContext('2d');
        g.overlay = { canvas: overlayCanvas, ctx: overlayCtx };

        if (gdto.fogURL) {
          var fi = new Image();
          fi.onload = (function (fc, fctx) {
            return function () { fctx.clearRect(0, 0, w, h); fctx.drawImage(fc, 0, 0); };
          }(fi, fogCtx));
          fi.src = gdto.fogURL;
        }

        if (gdto.overlayURL) {
          var oi = new Image();
          oi.onload = (function (oc, octx) {
            return function () { octx.drawImage(oc, 0, 0); };
          }(oi, overlayCtx));
          oi.src = gdto.overlayURL;
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

      // Create overlay canvas for migrated group
      var ovCanvas = document.createElement('canvas');
      ovCanvas.width = w; ovCanvas.height = h;
      dg.overlay = { canvas: ovCanvas, ctx: ovCanvas.getContext('2d') };

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
      S.playerGroupId = data.playerGroupId || S.activeGroupId;
      if (!S.groups.find(function (g) { return g.id === S.playerGroupId; })) {
        S.playerGroupId = S.groups[0] ? S.groups[0].id : null;
      }
      document.getElementById('world-w').value = w;
      document.getElementById('world-h').value = h;
      // Discard any in-progress fog session (state no longer applies after reload)
      S.fogSession.active = false;
      S.fogSession.snapshot = null;
      S.fogSession.groupId  = null;
      hideFogSessionBar();
      rebuildGroupTabs();
      rebuildLayerPanel();
      rebuildCheckpointPanel();
      broadcastFull();
      toast('Scenario loaded');
    }
  }

  function clearScenario() {
    if (!confirm('Clear all groups, layers, checkpoints and reset fog? This cannot be undone.')) return;
    // Discard fog session before clearing
    S.fogSession.active = false;
    S.fogSession.snapshot = null;
    S.fogSession.groupId  = null;
    hideFogSessionBar();
    var dg        = makeGroup('Surface');
    S.groups        = [dg];
    S.activeGroupId = dg.id;
    S.playerGroupId = dg.id;
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
    document.getElementById('btn-pause').addEventListener('click', togglePause);
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

    // Sample map picker – close details on selection
    document.querySelectorAll('.sample-menu li').forEach(function (li) {
      li.addEventListener('click', function () {
        addSampleLayer(li.dataset.sample);
        li.closest('details').removeAttribute('open');
      });
    });

    // Fog session bar buttons
    document.getElementById('btn-fog-commit').addEventListener('click', commitFogSession);
    document.getElementById('btn-fog-revert').addEventListener('click', revertFogSession);

    document.querySelectorAll('.tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tool-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        S.tool = btn.dataset.tool;
        updateCursor();
      });
    });

    // Texture palette – clicking a brush also switches to the texture tool
    document.querySelectorAll('.tex-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tex-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        S.textureBrush = btn.dataset.tex;
        // Auto-switch to texture tool
        document.querySelectorAll('.tool-btn').forEach(function (b) { b.classList.remove('active'); });
        var texBtn = document.querySelector('.tool-btn[data-tool="texture"]');
        if (texBtn) texBtn.classList.add('active');
        S.tool = 'texture';
        updateCursor();
      });
    });

    // Minimap toggle
    document.getElementById('btn-minimap-toggle').addEventListener('click', function () {
      S.minimapVisible = !S.minimapVisible;
      var mc = document.getElementById('minimap-canvas');
      if (mc) mc.classList.toggle('hidden', !S.minimapVisible);
      this.classList.toggle('active', S.minimapVisible);
    });

    // Minimap click-to-navigate
    var minimapCanvas = document.getElementById('minimap-canvas');
    if (minimapCanvas) {
      minimapCanvas.addEventListener('click', function (ev) {
        if (!S.minimapVisible) return;
        var rect = minimapCanvas.getBoundingClientRect();
        var scaleX = minimapCanvas.width  / rect.width;
        var scaleY = minimapCanvas.height / rect.height;
        var mx = (ev.clientX - rect.left) * scaleX;
        var my = (ev.clientY - rect.top)  * scaleY;
        var scl = Math.min(minimapCanvas.width / S.world.w, minimapCanvas.height / S.world.h);
        var offX = (minimapCanvas.width  - S.world.w * scl) / 2;
        var offY = (minimapCanvas.height - S.world.h * scl) / 2;
        var wx = (mx - offX) / scl;
        var wy = (my - offY) / scl;
        S.vp.x = canvas.width  / 2 - wx * S.vp.zoom;
        S.vp.y = canvas.height / 2 - wy * S.vp.zoom;
        throttleBroadcastViewport();
      });
    }

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

    // Grid opacity slider
    var gridOpSlider = document.getElementById('grid-opacity');
    var gridOpVal    = document.getElementById('grid-opacity-val');
    gridOpSlider.addEventListener('input', function () {
      gridOpVal.textContent = gridOpSlider.value + '%';
    });

    // Mobile panel toggles
    (function () {
      var backdrop   = document.getElementById('panel-backdrop');
      var layerPanel = document.getElementById('layer-panel');
      var toolsPanel = document.getElementById('tools-panel');

      function closePanels() {
        layerPanel.classList.remove('panel-open');
        toolsPanel.classList.remove('panel-open');
        backdrop.classList.remove('active');
      }

      document.getElementById('btn-toggle-layers').addEventListener('click', function () {
        var opening = !layerPanel.classList.contains('panel-open');
        closePanels();
        if (opening) {
          layerPanel.classList.add('panel-open');
          backdrop.classList.add('active');
        }
      });

      document.getElementById('btn-toggle-tools').addEventListener('click', function () {
        var opening = !toolsPanel.classList.contains('panel-open');
        closePanels();
        if (opening) {
          toolsPanel.classList.add('panel-open');
          backdrop.classList.add('active');
        }
      });

      backdrop.addEventListener('click', closePanels);
    }());

    window.addEventListener('keydown', function (e) {
      if (e.target.isContentEditable || e.target.tagName === 'INPUT') return;
      // Fog session shortcuts
      if (S.fogSession.active) {
        if (e.key === 'Enter') { e.preventDefault(); commitFogSession(); return; }
        if (e.key === 'Escape') { e.preventDefault(); revertFogSession(); return; }
      }
      var map = { r: 'reveal', h: 'hide', p: 'pan', t: 'transform', x: 'texture' };
      if (map[e.key.toLowerCase()]) {
        document.querySelectorAll('.tool-btn').forEach(function (b) { b.classList.remove('active'); });
        var btn = document.querySelector('.tool-btn[data-tool="' + map[e.key.toLowerCase()] + '"]');
        if (btn) btn.classList.add('active');
        S.tool = map[e.key.toLowerCase()];
        updateCursor();
      }
      if (e.key === 'f' || e.key === 'F') fitView();
      if (e.key === 'q' || e.key === 'Q') togglePause();
      if (e.key === 'm' || e.key === 'M') {
        var mmBtn = document.getElementById('btn-minimap-toggle');
        if (mmBtn) mmBtn.click();
      }
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
