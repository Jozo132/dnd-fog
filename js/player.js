/**
 * DnD Fog of War – Player / Projector View
 * js/player.js  (v3 – Layer Groups)
 */
(function () {
  'use strict';

  var canvas, ctx, bc;

  var P = {
    world:         { w: 1920, h: 1080 },
    vp:            { x: 0, y: 0, zoom: 1 },
    groups:        [],   // { id, visible, layers:[], fogImg:null, overlayImg:null }
    activeGroupId: null,
    ready:         false,
  };

  // ─── Hatched pattern for out-of-bounds areas ──────────────────────────────
  var _hatchPattern = null;
  function getHatchPattern(targetCtx) {
    if (_hatchPattern) return _hatchPattern;
    var pc = document.createElement('canvas');
    pc.width = 16; pc.height = 16;
    var pctx = pc.getContext('2d');
    pctx.strokeStyle = 'rgba(255,255,255,0.06)';
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(0, 16); pctx.lineTo(16, 0);
    pctx.moveTo(-4, 4); pctx.lineTo(4, -4);
    pctx.moveTo(12, 20); pctx.lineTo(20, 12);
    pctx.stroke();
    _hatchPattern = targetCtx.createPattern(pc, 'repeat');
    return _hatchPattern;
  }

  function drawOutOfBoundsHatch(targetCtx, worldW, worldH, vpX, vpY, zoom, canvasW, canvasH) {
    targetCtx.save();
    // Clip to everything outside the world rect (in screen space)
    targetCtx.beginPath();
    targetCtx.rect(0, 0, canvasW, canvasH);
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

    targetCtx.fillStyle = '#080818';
    targetCtx.fillRect(0, 0, canvasW, canvasH);
    targetCtx.fillStyle = getHatchPattern(targetCtx);
    targetCtx.fillRect(0, 0, canvasW, canvasH);
    targetCtx.restore();
  }

  function activeGroup() {
    if (!P.groups.length) return null;
    return P.groups.find(function (g) { return g.id === P.activeGroupId; }) || P.groups[0];
  }

  function init() {
    canvas = document.getElementById('player-canvas');
    ctx    = canvas.getContext('2d');

    resizeCanvas();
    window.addEventListener('resize', function () {
      resizeCanvas();
      sendPlayerViewport();
    });

    bc = new BroadcastChannel('dnd-fog');
    bc.onmessage = function (e) {
      var type    = e.data.type;
      var payload = e.data.payload;
      if (type === 'FULL_STATE')      { applyFullState(payload); }
      else if (type === 'FOG_UPDATE')     { applyFogUpdate(payload); }
      else if (type === 'OVERLAY_UPDATE') { applyOverlayUpdate(payload); }
      else if (type === 'VP_UPDATE')      { P.vp.x = payload.vp.x; P.vp.y = payload.vp.y; P.vp.zoom = payload.vp.zoom; }
    };

    bc.postMessage({ type: 'PLAYER_HELLO' });
    sendPlayerViewport();

    requestAnimationFrame(renderLoop);
  }

  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function sendPlayerViewport() {
    if (!bc) return;
    bc.postMessage({ type: 'PLAYER_VIEWPORT', payload: { w: canvas.width, h: canvas.height } });
  }

  // ─── State application ────────────────────────────────────────────────────

  function applyFullState(payload) {
    P.world.w     = payload.world.w;
    P.world.h     = payload.world.h;
    P.vp.x        = payload.vp.x;
    P.vp.y        = payload.vp.y;
    P.vp.zoom     = payload.vp.zoom;
    P.activeGroupId = payload.activeGroupId;

    // Preserve existing fogImg for any group that hasn't changed
    var existingGroups = {};
    P.groups.forEach(function (g) { existingGroups[g.id] = g; });

    var groupDTOs = payload.groups || [];

    if (groupDTOs.length === 0) {
      P.groups = [];
      P.ready  = true;
      hideWaiting();
      return;
    }

    // Build new groups array; carry over cached fogImg / overlayImg where possible
    P.groups = groupDTOs.map(function (gdto) {
      var prev = existingGroups[gdto.id] || {};
      return {
        id:         gdto.id,
        visible:    gdto.visible !== false,
        fogImg:     prev.fogImg     || null,
        overlayImg: prev.overlayImg || null,
        layers:     [],
      };
    });

    // Re-load fog and overlay for every group from the DTO
    groupDTOs.forEach(function (gdto, gi) {
      if (gdto.fogURL) {
        var fi = new Image();
        fi.onload = (function (groupIdx) {
          return function () { P.groups[groupIdx].fogImg = this; };
        }(gi));
        fi.src = gdto.fogURL;
      }
      if (gdto.overlayURL) {
        var oi = new Image();
        oi.onload = (function (groupIdx) {
          return function () { P.groups[groupIdx].overlayImg = this; };
        }(gi));
        oi.src = gdto.overlayURL;
      }
    });

    // Load layers for all groups concurrently
    var totalLayers = groupDTOs.reduce(function (sum, g) { return sum + (g.layers ? g.layers.length : 0); }, 0);
    if (totalLayers === 0) {
      P.ready = true;
      hideWaiting();
      return;
    }

    var loadedLayers = 0;

    groupDTOs.forEach(function (gdto, gi) {
      var dtos = gdto.layers || [];
      if (dtos.length === 0) return;

      P.groups[gi].layers = new Array(dtos.length).fill(null);

      dtos.forEach(function (dto, idx) {
        var img = new Image();
        img.onload = (function (d, i, groupIdx) {
          return function () {
            P.groups[groupIdx].layers[i] = {
              img:     this,
              x: d.x, y: d.y,
              w: d.w, h: d.h,
              sx: d.sx, sy: d.sy,
              opacity: d.opacity,
              visible: d.visible,
            };
            loadedLayers++;
            if (loadedLayers === totalLayers) {
              P.groups.forEach(function (g) { g.layers = g.layers.filter(Boolean); });
              P.ready = true;
              hideWaiting();
            }
          };
        }(dto, idx, gi));
        img.onerror = (function (d) {
          return function () {
            console.warn('Player: failed to load layer "' + d.name + '"');
            loadedLayers++;
            if (loadedLayers === totalLayers) {
              P.groups.forEach(function (g) { g.layers = g.layers.filter(Boolean); });
              P.ready = true;
              hideWaiting();
            }
          };
        }(dto));
        img.src = dto.dataURL;
      });
    });
  }

  function applyFogUpdate(payload) {
    if (!payload.fogURL || !payload.groupId) return;
    var g = P.groups.find(function (x) { return x.id === payload.groupId; });
    if (!g) return;
    var img   = new Image();
    var group = g;
    img.onload = function () { group.fogImg = this; };
    img.src = payload.fogURL;
  }

  function applyOverlayUpdate(payload) {
    if (!payload.overlayURL || !payload.groupId) return;
    var g = P.groups.find(function (x) { return x.id === payload.groupId; });
    if (!g) return;
    var img   = new Image();
    var group = g;
    img.onload = function () { group.overlayImg = this; };
    img.src = payload.overlayURL;
  }

  function hideWaiting() {
    var w = document.getElementById('waiting');
    if (w) w.style.display = 'none';
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  function renderLoop() {
    requestAnimationFrame(renderLoop);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var g = activeGroup();
    if (!g) return;

    ctx.save();
    ctx.translate(P.vp.x, P.vp.y);
    ctx.scale(P.vp.zoom, P.vp.zoom);

    ctx.fillStyle = '#0d0d1e';
    ctx.fillRect(0, 0, P.world.w, P.world.h);

    // Layers – bottom to top
    for (var i = g.layers.length - 1; i >= 0; i--) {
      var l = g.layers[i];
      if (!l || !l.visible || !l.img || !l.img.complete) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.img, l.x, l.y, l.w * l.sx, l.h * l.sy);
      ctx.restore();
    }

    // Texture overlay (beneath fog, visible to players)
    if (g.overlayImg) {
      ctx.drawImage(g.overlayImg, 0, 0);
    }

    // Fog – fully opaque so players cannot see unrevealed areas
    if (g.fogImg) {
      ctx.drawImage(g.fogImg, 0, 0);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, P.world.w, P.world.h);
    }

    ctx.restore();

    // Hatched out-of-bounds area (drawn in screen space)
    drawOutOfBoundsHatch(ctx, P.world.w, P.world.h, P.vp.x, P.vp.y, P.vp.zoom, canvas.width, canvas.height);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
