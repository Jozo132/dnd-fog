/**
 * DnD Fog of War – Player / Projector View
 * js/player.js
 */
(function () {
  'use strict';

  let canvas, ctx;

  const P = {
    world:  { w: 1920, h: 1080 },
    vp:     { x: 0, y: 0, zoom: 1 },
    layers: [],
    fogImg: null,
    ready:  false,
  };

  function init() {
    canvas = document.getElementById('player-canvas');
    ctx    = canvas.getContext('2d');

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Connect to DM via BroadcastChannel
    const bc = new BroadcastChannel('dnd-fog');
    bc.onmessage = e => {
      const { type, payload } = e.data;
      switch (type) {
        case 'FULL_STATE':  applyFullState(payload);  break;
        case 'FOG_UPDATE':  applyFogUpdate(payload);  break;
        case 'VP_UPDATE':   P.vp = { ...payload.vp }; break;
      }
    };

    // Announce presence so DM sends us the current state
    bc.postMessage({ type: 'PLAYER_HELLO' });

    requestAnimationFrame(renderLoop);
  }

  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  // ─── State application ────────────────────────────────────────────────────

  function applyFullState(payload) {
    P.world = { ...payload.world };
    P.vp    = { ...payload.vp };

    applyFogUpdate({ fogURL: payload.fogURL });

    P.layers = new Array(payload.layers.length).fill(null);
    let loaded = 0;
    const total = payload.layers.length;

    function onLayerLoaded() {
      loaded++;
      if (loaded === total) { P.ready = true; hideWaiting(); }
    }

    payload.layers.forEach((dto, idx) => {
      const img = new Image();
      img.onload = () => {
        P.layers[idx] = {
          img,
          x: dto.x, y: dto.y,
          w: dto.w, h: dto.h,
          sx: dto.sx, sy: dto.sy,
          opacity: dto.opacity,
          visible: dto.visible,
        };
        onLayerLoaded();
      };
      img.onerror = () => {
        console.warn(`Player view: failed to load image for layer index ${idx}`);
        onLayerLoaded();
      };
      img.src = dto.dataURL;
    });

    if (total === 0) { P.ready = true; hideWaiting(); }
  }

  function applyFogUpdate(payload) {
    if (!payload.fogURL) return;
    const img  = new Image();
    img.onload = () => { P.fogImg = img; };
    img.src    = payload.fogURL;
  }

  function hideWaiting() {
    const w = document.getElementById('waiting');
    if (w) w.style.display = 'none';
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  function renderLoop() {
    requestAnimationFrame(renderLoop);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(P.vp.x, P.vp.y);
    ctx.scale(P.vp.zoom, P.vp.zoom);

    // World background
    ctx.fillStyle = '#0d0d1e';
    ctx.fillRect(0, 0, P.world.w, P.world.h);

    // Layers – bottom to top
    for (let i = P.layers.length - 1; i >= 0; i--) {
      const l = P.layers[i];
      if (!l || !l.visible || !l.img.complete) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.img, l.x, l.y, l.w * l.sx, l.h * l.sy);
      ctx.restore();
    }

    // Fog – fully opaque for players
    if (P.fogImg) {
      ctx.drawImage(P.fogImg, 0, 0);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, P.world.w, P.world.h);
    }

    ctx.restore();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
