/* touch.js - window.TouchInput: on-screen controls for phones and tablets.

   Layout (landscape):
     left thumb    floating stick: touch anywhere on the left 44 % of the screen, drag to move (analog speed); push it to the edge to sprint
     right thumb   drag anywhere on the right to aim
     FIRE          fires (semi-auto, like the mouse button); keep the finger down and drag to aim while shooting
     RELOAD        reloads         SPRINT (above RELOAD)   toggles a latched sprint
     GRENADE       (above FIRE, only while you hold grenades from a kill streak) lobs one
     top right     pause and mute (the touch versions of Esc and M)
   Touch mode switches on when the primary pointer is coarse, on the first real touch, or with ?touch=1 (QA / desktop testing; ?touch=0
   forces it off). Pressing START with a mouse switches it off again (a touch laptop). Nothing is drawn or handled while it is off.

   Integration (no other module knows about touch except through these):
     TouchInput.active / ax / ay / sprint   read by Game's getInput (analog move vector, -1..1, ay > 0 = forward)
     body.touch                             CSS: shows #touchUI, rearranges the HUD, swaps the controls help on the title screen
     main.js skips the pointer lock request while active; this module pauses the game when the page is hidden or turned to portrait
   Look: the camera quaternion is turned exactly like THREE.PointerLockControls does it (yaw about world Y, pitch about X, clamped), so
   the recoil kick that is baked into the camera survives. */
(function () {
  'use strict';

  const q = location.search;
  const forced = /[?&]touch=1(?:&|#|$)/.test(q);
  const forbidden = /[?&]touch=0(?:&|#|$)/.test(q);
  const media = (s) => { try { return !!window.matchMedia && matchMedia(s).matches; } catch (e) { return false; } };

  const LOOK_SENS = 0.0042;          // rad per CSS pixel dragged
  const DEAD = 0.12;                 // stick dead zone (fraction of its radius)
  const SPRINT_ON = 0.92, SPRINT_OFF = 0.8;

  const T = {
    active: false,
    ax: 0, ay: 0,                    // stick, -1..1 (ax > 0 = right, ay > 0 = forward)
    sprint: false,                   // stick at its edge, or the latch
    latch: false,
    forced: forced,

    setActive: function (on) {
      on = !!on && !forbidden;
      if (on === T.active) return T.active;
      T.active = on;
      if (document.body) document.body.classList.toggle('touch', on);
      T.reset();
      const p = document.querySelector('#pauseScreen p'), hint = document.querySelector('#lock .hint');
      if (p) p.textContent = on ? 'Tap to resume' : 'Click to resume';
      if (hint) hint.textContent = on ? 'Tap START to play.' : 'Click START to capture the mouse.';
      return T.active;
    },

    // let go of everything (pause, tab switch, rotation)
    reset: function () {
      stick = null; lookId = null; fireId = null;
      T.ax = 0; T.ay = 0; T.stickSprint = false; T.sprint = T.latch;
      if (E.base) { E.base.classList.remove('on'); E.base.style.left = ''; E.base.style.bottom = ''; E.knob.style.transform = ''; }
      if (E.fire) E.fire.classList.remove('down');
    },
  };
  window.TouchInput = T;

  const E = {};
  let stick = null;                  // { id, cx, cy, r }  the finger on the stick
  let lookId = null, lookX = 0, lookY = 0;
  let fireId = null, fireX = 0, fireY = 0;
  let euler = null;

  function rotate(dx, dy) {
    const cam = window.Game && Game.camera;
    if (!cam || (window.Game && Game.dead)) return;
    if (!euler) euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(cam.quaternion);
    euler.y -= dx * LOOK_SENS;
    euler.x -= dy * LOOK_SENS;
    euler.x = Math.max(-1.5, Math.min(1.5, euler.x));
    cam.quaternion.setFromEuler(euler);
  }

  function capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic / released pointer */ } }
  function stop(e) { if (e.cancelable) e.preventDefault(); e.stopPropagation(); }

  // ---------------------------------------------------------------- left thumb: floating stick
  function stickDown(e) {
    stop(e);
    if (stick) return;
    const r = E.base.offsetWidth * 0.36;                       // knob travel
    const half = E.base.offsetWidth / 2, m = 12;
    // the base re-centres under the thumb (kept on screen), the knob starts at its centre
    const cx = Math.max(half + m, Math.min(innerWidth - half - m, e.clientX));
    const cy = Math.max(half + m, Math.min(innerHeight - half - m, e.clientY));
    stick = { id: e.pointerId, cx: cx, cy: cy, r: r };
    E.base.style.left = (cx - half) + 'px';
    E.base.style.bottom = (innerHeight - cy - half) + 'px';
    E.base.classList.add('on');
    capture(E.zone, e);
    stickMove(e);
  }
  function stickMove(e) {
    if (!stick || e.pointerId !== stick.id) return;
    stop(e);
    const dx = e.clientX - stick.cx, dy = e.clientY - stick.cy;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, len / stick.r);
    const dir = k < DEAD ? 0 : (k - DEAD) / (1 - DEAD);          // dead zone, then 0..1
    T.ax = (dx / len) * dir;
    T.ay = (-dy / len) * dir;
    if (k >= SPRINT_ON) T.stickSprint = true; else if (k <= SPRINT_OFF) T.stickSprint = false;
    T.sprint = T.latch || !!T.stickSprint;
    E.knob.style.transform = 'translate(' + (dx / len * Math.min(len, stick.r)) + 'px,' + (dy / len * Math.min(len, stick.r)) + 'px)';
  }
  function stickUp(e) {
    if (!stick || e.pointerId !== stick.id) return;
    stop(e);
    stick = null;
    T.ax = 0; T.ay = 0; T.stickSprint = false; T.sprint = T.latch;
    E.base.classList.remove('on');
    E.base.style.left = ''; E.base.style.bottom = '';
    E.knob.style.transform = '';
  }

  // ---------------------------------------------------------------- right thumb: look
  function lookDown(e) {
    stop(e);
    if (lookId !== null) return;
    lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY;
    capture(E.look, e);
  }
  function lookMove(e) {
    if (e.pointerId !== lookId) return;
    stop(e);
    rotate(e.clientX - lookX, e.clientY - lookY);
    lookX = e.clientX; lookY = e.clientY;
  }
  function lookUp(e) { if (e.pointerId === lookId) { stop(e); lookId = null; } }

  // ---------------------------------------------------------------- buttons
  function press(btn, fn) {
    btn.addEventListener('pointerdown', function (e) { stop(e); btn.classList.add('down'); capture(btn, e); try { fn(e); } catch (err) { console.error('[touch]', err); } });
    const up = function (e) { btn.classList.remove('down'); stop(e); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  }

  function fireDown(e) {
    stop(e);
    E.fire.classList.add('down');
    capture(E.fire, e);
    if (fireId === null) { fireId = e.pointerId; fireX = e.clientX; fireY = e.clientY; }
    if (window.Game && Game.tryFire) { try { Game.tryFire(); } catch (err) { console.error('[touch] fire', err); } }
  }
  function fireMove(e) {
    if (e.pointerId !== fireId) return;
    stop(e);
    rotate(e.clientX - fireX, e.clientY - fireY);                // aim while the finger stays on FIRE
    fireX = e.clientX; fireY = e.clientY;
  }
  function fireUp(e) {
    if (e.pointerId !== fireId) return;
    stop(e);
    fireId = null;
    E.fire.classList.remove('down');
  }

  function pauseGame() {
    T.reset();
    if (window.Main && Main.isStarted && Main.isStarted() && Main.pause) Main.pause();
  }
  function shouldPause() {
    const W = window.Waves;
    return window.Main && Main.isStarted && Main.isStarted() && !Main.isPaused() && !(window.Game && Game.dead) && !(W && W.state === 'victory');
  }

  function init() {
    ['look', 'zone', 'base', 'knob', 'fire', 'reload', 'sprint', 'grenade', 'pause', 'mute'].forEach(function (k) {
      E[k] = document.getElementById({ look: 'touchLook', zone: 'stickZone', base: 'stickBase', knob: 'stickKnob', fire: 'tFire', reload: 'tReload',
        sprint: 'tSprint', grenade: 'tGrenade', pause: 'tPause', mute: 'tMute' }[k]);
    });
    if (!E.look || !E.zone || !E.base || !E.fire) return;           // markup missing: touch controls are simply off

    E.zone.addEventListener('pointerdown', stickDown);
    E.zone.addEventListener('pointermove', stickMove);
    E.zone.addEventListener('pointerup', stickUp);
    E.zone.addEventListener('pointercancel', stickUp);
    E.look.addEventListener('pointerdown', lookDown);
    E.look.addEventListener('pointermove', lookMove);
    E.look.addEventListener('pointerup', lookUp);
    E.look.addEventListener('pointercancel', lookUp);
    E.fire.addEventListener('pointerdown', fireDown);
    E.fire.addEventListener('pointermove', fireMove);
    E.fire.addEventListener('pointerup', fireUp);
    E.fire.addEventListener('pointercancel', fireUp);

    press(E.reload, function () { if (window.Game && Game.tryReload) Game.tryReload(); });
    if (E.grenade) press(E.grenade, function () { if (window.Grenade && Grenade.throwIt) Grenade.throwIt(); });
    press(E.sprint, function () {
      T.latch = !T.latch;
      E.sprint.classList.toggle('on', T.latch);
      T.sprint = T.latch || !!T.stickSprint;
    });
    // PAUSE acts on click, not pointerdown: the overlay it opens would otherwise receive the tap's own click and resume at once
    E.pause.addEventListener('pointerdown', function (e) { stop(e); capture(E.pause, e); });
    E.pause.addEventListener('click', function (e) { e.stopPropagation(); pauseGame(); });
    press(E.mute, function () {
      if (!window.Sfx || !Sfx.mute) return;
      E.mute.classList.toggle('on', !!Sfx.mute());
    });

    // never let the browser scroll, zoom or open a context menu over the game
    document.addEventListener('contextmenu', function (e) { if (T.active) e.preventDefault(); });
    document.addEventListener('gesturestart', function (e) { if (T.active) e.preventDefault(); });
    document.addEventListener('touchmove', function (e) { if (T.active && e.cancelable && !e.target.closest('#lock')) e.preventDefault(); }, { passive: false });

    // START: decide touch or mouse from the pointer that pressed it, then (touch) try for fullscreen + landscape
    const startBtn = document.getElementById('startBtn');
    if (startBtn) {
      startBtn.addEventListener('pointerdown', function (e) {
        if (forbidden) return;
        if (e.pointerType === 'touch' || e.pointerType === 'pen') T.setActive(true);
        else if (e.pointerType === 'mouse' && !forced) T.setActive(false);
      });
      startBtn.addEventListener('click', function () {
        if (!T.active || forced) return;
        try {
          const el = document.documentElement;
          const fs = el.requestFullscreen ? el.requestFullscreen() : (el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null);
          const lock = function () { try { screen.orientation.lock('landscape').catch(function () { /* not allowed */ }); } catch (err) { /* unsupported */ } };
          if (fs && fs.then) fs.then(lock, function () { /* refused */ }); else lock();
        } catch (err) { /* fullscreen is a nicety */ }
      });
    }

    // the page left the screen, or the phone was turned upright: pause instead of dying unseen
    document.addEventListener('visibilitychange', function () { if (document.hidden && T.active && shouldPause()) pauseGame(); });
    window.addEventListener('pagehide', function () { T.reset(); });
    try {
      const portrait = matchMedia('(orientation: portrait)');
      const onTurn = function (e) { if (e.matches && T.active && shouldPause()) pauseGame(); };
      if (portrait.addEventListener) portrait.addEventListener('change', onTurn); else if (portrait.addListener) portrait.addListener(onTurn);
    } catch (e) { /* ignore */ }
  }

  // a real touch before START turns touch mode on (tablets that report a fine pointer, hybrids)
  window.addEventListener('touchstart', function () { if (!T.active && !forbidden && !(window.Main && Main.isStarted && Main.isStarted())) T.setActive(true); }, { passive: true, once: true });

  function boot() {
    init();
    T.setActive(forced || (!forbidden && media('(pointer: coarse)') && media('(hover: none)')));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
