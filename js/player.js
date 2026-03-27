/**
 * DnD Fog of War – Player / Projector View
 * js/player.js  (v3 – Layer Groups)
 */
(function () {
  'use strict';

  var canvas, ctx;

  var P = {
    world:         { w: 1920, h: 1080 },
    vp:            { x: 0, y: 0, zoom: 1 },
    groups:        [],   // { id, visible, layers:[], fogImg:null, overlayImg:null }
    activeGroupId: null,
    ready:         false,
  };

  function activeGroup() {
    if (!P.groups.length) return null;
    return P.groups.find(function (g) { return g.id === P.activeGroupId; }) || P.groups[0];
  }

  function init() {
    canvas = document.getElementById('player-canvas');
    ctx    = canvas.getContext('2d');

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    var bc = new BroadcastChannel('dnd-fog');
    bc.onmessage = function (e) {
      var type    = e.data.type;
      var payload = e.data.payload;
      if (type === 'FULL_STATE')      { applyFullState(payload); }
      else if (type === 'FOG_UPDATE')     { applyFogUpdate(payload); }
      else if (type === 'OVERLAY_UPDATE') { applyOverlayUpdate(payload); }
      else if (type === 'VP_UPDATE')      { P.vp.x = payload.vp.x; P.vp.y = payload.vp.y; P.vp.zoom = payload.vp.zoom; }
    };

    bc.postMessage({ type: 'PLAYER_HELLO' });

    requestAnimationFrame(renderLoop);
  }

  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
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
  }

  document.addEventListener('DOMContentLoaded', init);
})();
