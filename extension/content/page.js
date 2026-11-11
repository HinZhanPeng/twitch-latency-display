// Runs in the page's MAIN world so it can reach Twitch's player object.
(() => {
  'use strict';
  if (window.__tldLoaded) return;
  window.__tldLoaded = true;

  // The catch-up logic and its tuning constants live in controller.js (loaded first).
  const { C, createController } = window.__tldController;
  delete window.__tldController;

  // ---------------------------------------------------------------- config
  const HISTORY_MS = 60_000;
  const LOOKUP_EVERY_MS = 4000;  // re-check a known player this often
  const LOOKUP_RETRY_MS = 1000;  // search for a missing one this often
  const BLIND_AFTER_MS = 10_000; // a stream plays this long with no readable player: say so

  // Stuck far behind live with nothing buffered to skip: resync through Twitch's player.
  const BASE_WINDOW_MS = 5000;     // a latency must hold this long to count as the stream's normal
  const BEHIND_BY = 8;             // this far over the stream's normal latency (s) ...
  const BEHIND_FOR_MS = 10_000;    // ... for this long, with no buffer to skip: resync
  const RESYNC_EVERY_MS = 120_000; // at most one automatic resync per this long
  const RESYNC_MAX = 3;            // automatic resyncs per stream before giving up
  const RESYNC_GAP = 3;            // badge click resyncs when latency exceeds buffer by this (s)

  const CHANNEL = 'twitch-latency-display';
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

  // ---------------------------------------------------------------- popout chat
  // No player here: just show the latency the player tab broadcasts, and stop.
  const pop = location.pathname.match(/^\/popout\/([^/]+)\/chat/i);
  if (pop) {
    const want = pop[1].toLowerCase();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:12px;bottom:96px;z-index:9999;padding:3px 9px;border-radius:999px;' +
      'background:rgba(14,14,16,.8);color:#efeff1;font:600 12px/18px Inter,Roobert,Arial,sans-serif;' +
      'font-variant-numeric:tabular-nums;pointer-events:none;display:none';
    document.body.appendChild(el);
    let hideTimer;
    bc?.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.channel !== want || typeof d.lat !== 'number' || !Number.isFinite(d.lat)) return;
      const rate = typeof d.rate === 'number' && Number.isFinite(d.rate) ? d.rate : 1;
      el.textContent = `${d.lat.toFixed(1)}s${rate > 1.004 ? ` · ${rate.toFixed(2)}×` : ''}`;
      el.style.display = 'block';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
    });
    return;
  }

  // Learned separately: low-latency and normal streams need very different buffers.
  const storeKey = (ll) => (ll ? 'tld.bufTarget.ll' : 'tld.bufTarget.std');
  const RESET_KEY = 'tld.resetToken'; // the popup reset this browser applied last

  // Starting values only; the bridge sends the stored settings (see shared/defaults.js).
  let S = { catchUp: true, mode: 'lowest', targetLatency: 3, maxRate: 1.15, showBadge: true, resetToken: 0 };

  // Catch-up state: learned buffer target, current rate, stall memory.
  const ctl = createController({ bufTarget: loadBufTarget(true), now: performance.now() });

  const st = {
    mp: null,
    lastLookup: -Infinity,
    lastTick: performance.now(),
    video: null,
    weSetRate: false,
    ll: true,                 // is the current stream low-latency?
    prevState: null,
    lastSeek: -Infinity,      // last seek actually performed (ours or a badge click)
    lastSeekTry: -Infinity,   // last time the controller asked for a seek, performed or not
    channel: '',
    baseLat: Infinity,        // lowest latency this stream has held steadily
    baseFrom: 0,              // ignore history older than this when finding baseLat
    behindSince: null,        // when latency first sat far above baseLat with no buffer to skip
    lastResync: -Infinity,
    resyncs: 0,               // automatic resyncs on this stream
    lastPlay: -Infinity,
    stalls: 0,
    hist: [],
    snap: null,
    blindSince: null,         // when a playing stream first had no readable player
    blind: false,
    blindWarned: false,
  };

  // ---------------------------------------------------------------- settings
  let settingsLoaded = false;
  document.addEventListener('tld:settings', (e) => {
    try {
      const next = sanitize(JSON.parse(e.detail));
      const token = next.resetToken;
      // Reset when the token changes while this tab is open, and also when it differs
      // from the one this browser last applied, so a reset pressed with no Twitch tab
      // open still lands on the next load.
      if (token !== undefined && ((settingsLoaded && token !== S.resetToken) || resetPending(token))) {
        try {
          localStorage.removeItem(storeKey(true));
          localStorage.removeItem(storeKey(false));
          localStorage.setItem(RESET_KEY, String(token));
        } catch { /* storage blocked */ }
        ctl.bufTarget = C.BUF_START;
        st.stalls = 0;
      }
      settingsLoaded = true;
      S = { ...S, ...next };
      if (!S.catchUp) release();
    } catch { /* ignore malformed */ }
  });
  document.dispatchEvent(new CustomEvent('tld:request-settings'));

  function resetPending(token) {
    try { return token !== (Number(localStorage.getItem(RESET_KEY)) || 0); }
    catch { return false; } // storage blocked: nothing is persisted, so nothing to clear
  }

  // The event is visible to (and forgeable by) page scripts, so accept only known
  // keys with sane values; anything else keeps the current setting.
  function sanitize(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const n = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
    if (typeof raw.catchUp === 'boolean') out.catchUp = raw.catchUp;
    if (typeof raw.showBadge === 'boolean') out.showBadge = raw.showBadge;
    if (raw.mode === 'lowest' || raw.mode === 'target') out.mode = raw.mode;
    const tl = n(raw.targetLatency, 1, 30); if (tl !== undefined) out.targetLatency = tl;
    const mr = n(raw.maxRate, 1, 1.5); if (mr !== undefined) out.maxRate = mr;
    if (typeof raw.resetToken === 'number' && Number.isFinite(raw.resetToken)) out.resetToken = raw.resetToken;
    return out;
  }

  function loadBufTarget(ll) {
    try {
      const v = Number(localStorage.getItem(storeKey(ll)));
      if (v >= C.BUF_FLOOR && v <= C.BUF_CEIL) return v;
    } catch { /* storage blocked */ }
    return C.BUF_START;
  }
  function saveBufTarget() {
    try { localStorage.setItem(storeKey(st.ll), ctl.bufTarget.toFixed(2)); } catch { /* storage blocked */ }
  }

  // ---------------------------------------------------------------- helpers
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  function call(obj, name) {
    try {
      const fn = obj?.[name];
      return typeof fn === 'function' ? fn.call(obj) : undefined;
    } catch { return undefined; }
  }
  function hasFn(obj, name) {
    try { return typeof obj?.[name] === 'function'; } catch { return false; }
  }

  function fiberOf(el) {
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
    }
    return null;
  }
  const isPlayer = (x) => !!x && typeof x === 'object' &&
    (typeof x.getBufferDuration === 'function' || typeof x.getLiveLatency === 'function' || !!x.playerInstance);

  const isActive = (mp) => {
    const s = call(mp, 'getState');
    return s !== 'Idle' && s !== 'Ended';
  };

  // Twitch passes the player around as the `mediaPlayerInstance` prop.
  function findPlayer() {
    // 1) walk up the React tree from each <video>; prefer a player that is actually running
    let fallback = null;
    for (const v of document.querySelectorAll('video')) {
      for (let el = v, i = 0; el && i < 20; el = el.parentElement, i++) {
        let f = fiberOf(el);
        if (!f) continue;
        for (let j = 0; f && j < 120; f = f.return, j++) {
          const p = f.memoizedProps?.mediaPlayerInstance;
          if (isPlayer(p)) {
            if (isActive(p)) return p;
            fallback ??= p;
            break;
          }
        }
        break; // the .return chain already covered every ancestor
      }
    }
    if (fallback) return fallback;
    // 2) walk down from known player containers
    for (const root of document.querySelectorAll('.persistent-player, [data-a-target="video-player"], .video-player')) {
      const f0 = fiberOf(root);
      if (!f0) continue;
      const stack = [f0];
      for (let n = 0; stack.length && n < 4000; n++) {
        const f = stack.pop();
        const p = f.memoizedProps?.mediaPlayerInstance;
        if (isPlayer(p)) return p;
        if (f !== f0 && f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    }
    return null;
  }

  function pickVideo(mp) {
    const own = call(mp, 'getHTMLVideoElement');
    if (own instanceof HTMLVideoElement && own.isConnected) return own;
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (v.readyState > 0 && a > bestArea) { best = v; bestArea = a; }
    }
    return best;
  }

  function bufferedEnd(video) {
    const b = video.buffered;
    return b.length ? b.end(b.length - 1) : undefined;
  }
  function videoBuffer(video) {
    if (!video) return undefined;
    const b = video.buffered, t = video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
    }
    return 0;
  }

  const readLatency = (mp) =>
    num(call(mp, 'getLiveLatency')) ??
    num(mp?.playerInstance?.core?.state?.liveLatency) ??
    num(mp?.core?.state?.liveLatency);

  const readBuffer = (mp, video) => num(call(mp, 'getBufferDuration')) ?? videoBuffer(video);

  function isLivePath() {
    const p = location.pathname;
    return !/^\/(videos|clip|directory|settings|search|downloads|subscriptions|inventory|wallet|drops)\b/.test(p) &&
      !/\/(clip|videos|v)\//.test(p);
  }

  // ---------------------------------------------------------------- playback control
  // Twitch's player core (in a worker) forces live playback back to 1× within
  // milliseconds, and its own setPlaybackRate is ignored on live streams. So while
  // catch-up is active we shadow the element's playbackRate setter and drop the
  // core's writes, then hand control back once we return to 1×.
  const nativeRate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');

  function lockRate(v) {
    if (Object.prototype.hasOwnProperty.call(v, 'playbackRate')) return;
    Object.defineProperty(v, 'playbackRate', {
      configurable: true,
      get() { return nativeRate.get.call(this); },
      set(x) { if (!st.weSetRate || this !== st.video) nativeRate.set.call(this, x); },
    });
  }
  function unlockRate(v) {
    if (v && Object.prototype.hasOwnProperty.call(v, 'playbackRate')) delete v.playbackRate;
  }

  function setRate(r) {
    r = Math.round(r * 1000) / 1000;
    const v = st.video;
    if (!v) return;
    if (r === 1 && !st.weSetRate) return;
    if (r !== 1) lockRate(v);
    st.weSetRate = r !== 1;
    if (Math.abs(nativeRate.get.call(v) - r) > 0.001) nativeRate.set.call(v, r);
    if (!st.weSetRate) unlockRate(v);
  }

  function release() {
    ctl.release();
    if (st.weSetRate) setRate(1);
  }

  function seekBy(seconds) {
    const v = st.video;
    if (!v) return;
    const end = bufferedEnd(v);
    if (end === undefined) return;
    const to = Math.min(v.currentTime + seconds, end - ctl.bufTarget);
    if (to > v.currentTime + 0.2) {
      st.lastSeek = performance.now();
      v.currentTime = to;
    }
  }

  function jumpToLive() {
    const v = st.video;
    if (!v) return;
    const end = bufferedEnd(v);
    if (end === undefined) return;
    const to = end - ctl.bufTarget;
    const s = st.snap;
    // Nothing buffered to skip, yet far behind: the delay is upstream of the buffer.
    if (to <= v.currentTime + 0.2 && s?.live && s.lat - (s.buf ?? 0) > RESYNC_GAP && resync()) return;
    st.lastSeek = performance.now();
    if (v.paused) v.play().catch(() => {});
    v.currentTime = Math.max(v.currentTime, to);
  }

  // The player is fetching an old part of the stream, so seeking and speeding up have
  // nothing to work with. Pausing and resuming through Twitch's own player (what its
  // pause button does) makes it rejoin at the live edge.
  function resync() {
    const mp = st.mp;
    if (!hasFn(mp, 'pause') || !hasFn(mp, 'play')) return false;
    const now = performance.now();
    st.lastResync = now;
    st.lastSeek = now;          // the rebuffer that follows is ours, not a stall
    st.behindSince = null;
    release();
    call(mp, 'pause');
    setTimeout(() => call(mp, 'play'), 150);
    return true;
  }

  // Automatic version: latency sits far above what this stream held earlier while the
  // buffer has nothing to skip. Rate-limited and capped, so a stream that simply
  // cannot do better is left alone after a few tries.
  function watchBehind(now, live, lat, buf, paused) {
    const ch = channelName();
    if (ch !== st.channel) {
      st.channel = ch;
      st.baseLat = Infinity;
      st.behindSince = null;
      st.resyncs = 0;
      st.baseFrom = now;        // st.hist still holds the previous channel's samples
    }
    if (!live || paused || !S.catchUp) { st.behindSince = null; return; }

    // Baseline = the lowest latency held for a whole window (its highest reading),
    // so one stray low sample can't set it. The current sample is already in st.hist.
    const h = st.hist;
    let hi = lat, covered = false;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t < st.baseFrom) break;
      if (now - h[i].t > BASE_WINDOW_MS) { covered = true; break; }
      if (h[i].lat > hi) hi = h[i].lat;
    }
    if (covered && hi < st.baseLat) st.baseLat = hi;

    const stuck = lat - st.baseLat > BEHIND_BY && (buf ?? 0) - ctl.bufTarget <= C.BIG_GAP;
    if (!stuck) { st.behindSince = null; return; }
    st.behindSince ??= now;
    if (now - st.behindSince > BEHIND_FOR_MS && now - st.lastResync > RESYNC_EVERY_MS &&
        st.resyncs < RESYNC_MAX && resync()) st.resyncs++;
  }

  function onPlay() { st.lastPlay = performance.now(); }

  // Called from the <video> 'waiting' event and from the player entering 'Buffering'
  // (Twitch sometimes recovers a stall by restarting at live without 'waiting').
  function registerStall() {
    const now = performance.now();
    if (now - ctl.lastStall < 3000) return;        // same stall reported twice
    if (now - st.lastSeek < 2000) return;          // our own seek, not a real stall
    if (now - st.lastPlay < 3000) return;          // normal refill after resuming from pause
    if (!st.snap?.live || st.video?.paused) return;
    st.stalls++;
    if (ctl.stall(now, S.catchUp)) {               // raises the learned target
      saveBufTarget();
      release();
    }
  }
  const onWaiting = registerStall;

  // ---------------------------------------------------------------- main loop
  const channelName = () => (location.pathname.split('/')[1] || '').toLowerCase();

  function tick() {
    const now = performance.now();
    const dt = now - st.lastTick;
    st.lastTick = now;

    if (now - st.lastLookup > (st.mp ? LOOKUP_EVERY_MS : LOOKUP_RETRY_MS)) {
      st.lastLookup = now;
      const mp = findPlayer();
      if (mp !== st.mp) { st.mp = mp; ctl.engaged = false; }
    }

    const video = pickVideo(st.mp);
    if (video !== st.video) {
      st.video?.removeEventListener('waiting', onWaiting);
      st.video?.removeEventListener('play', onPlay);
      if (st.weSetRate && st.video) nativeRate.set.call(st.video, 1);
      unlockRate(st.video);
      st.weSetRate = false;
      ctl.rate = 1;
      ctl.bufHist = [];
      st.video = video;
      video?.addEventListener('waiting', onWaiting);
      video?.addEventListener('play', onPlay);
    }

    const lat = st.mp ? readLatency(st.mp) : undefined;
    const buf = st.mp ? readBuffer(st.mp, video) : videoBuffer(video);
    // A stopped player keeps reporting its last latency, so also require real playback.
    const live = !!video && video.readyState >= 2 && isActive(st.mp) &&
      isLivePath() && lat !== undefined && lat > 0;
    const lowLatency = call(st.mp, 'isLiveLowLatency');

    const ll = lowLatency !== false;
    if (ll !== st.ll) {
      st.ll = ll;
      ctl.bufTarget = loadBufTarget(ll);
      ctl.bufHist = [];
      release();
    }

    const state = call(st.mp, 'getState');
    if (st.prevState === 'Playing' &&
        (state === 'Buffering' || (state === 'Idle' && st.weSetRate))) registerStall();
    st.prevState = state;

    st.snap = { live, lat, buf, lowLatency, paused: !!video?.paused };

    // A stream is clearly playing on a channel page, yet the player object (or its
    // latency method) can't be found: most likely Twitch changed its internals.
    const unreadable = !!video && !video.paused && video.readyState >= 2 &&
      isLivePath() && !!channelName() &&
      (!st.mp || (lat === undefined && !hasFn(st.mp, 'getLiveLatency')));
    if (!unreadable) st.blindSince = null;
    else st.blindSince ??= now;
    st.blind = unreadable && now - st.blindSince > BLIND_AFTER_MS;
    if (st.blind && !st.blindWarned) {
      st.blindWarned = true;
      console.warn('[Latency Catch-Up] A stream is playing but the Twitch player could not be read. ' +
        'Twitch may have changed its player; see findPlayer() in content/page.js.');
    }

    if (video && lat !== undefined && buf !== undefined) {
      // Throttle on the last seek *attempt*: if a seek can't be carried out (nothing
      // seekable in video.buffered), the next ticks must fall back to speeding up
      // instead of asking for the same impossible seek forever at 1×.
      const lastSeek = Math.max(st.lastSeek, st.lastSeekTry);
      const r = ctl.step({ now, dt, lat, buf, playing: live && !video.paused, lastSeek }, S);
      if (r.targetChanged) saveBufTarget();
      if (r.seek) { st.lastSeekTry = now; seekBy(r.seek); }
      else setRate(ctl.rate);
    } else release();

    if (live) {
      st.hist.push({ t: now, lat, buf });
      while (st.hist.length && now - st.hist[0].t > HISTORY_MS) st.hist.shift();
      bc?.postMessage({ channel: channelName(), lat, buf, rate: ctl.rate });
    }
    watchBehind(now, live, lat, buf, !!video?.paused);

    badge.render();
  }

  // ---------------------------------------------------------------- badge UI
  const CSS = `
    :host { all: initial; position: absolute; top: 10px; left: 10px; z-index: 1000;
      font-family: Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif; }
    .pill { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
      background: rgba(14,14,16,.8); color: #efeff1;
      font-size: 13px; font-weight: 600; line-height: 18px; cursor: pointer; user-select: none;
      font-variant-numeric: tabular-nums; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
    .pill:hover { background: rgba(14,14,16,.9); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex: none; }
    .good { background: #00f593; } .ok { background: #ffd37a; } .bad { background: #ff4f4d; }
    .rate { font-size: 11px; color: #bf94ff; display: none; }
    .rate.on { display: inline; }
    .wrap { display: none; position: absolute; top: 100%; left: 0; padding-top: 6px; }
    :host(:hover) .wrap { display: block; }
    .panel { width: 236px; padding: 10px; border-radius: 8px; background: rgba(14,14,16,.94);
      color: #efeff1; font-size: 12px; line-height: 16px; box-shadow: 0 4px 16px rgba(0,0,0,.5); cursor: default; }
    canvas { display: block; width: 236px; height: 56px; margin-bottom: 6px; }
    .legend { display: flex; gap: 10px; color: #adadb8; font-size: 11px; margin-bottom: 6px; }
    .legend i { display: inline-block; width: 10px; height: 2px; vertical-align: middle; margin-right: 4px; }
    .row { display: flex; justify-content: space-between; padding: 1px 0; }
    .row b { font-weight: 600; font-variant-numeric: tabular-nums; }
    .hint { margin-top: 6px; color: #adadb8; font-size: 11px; }
    .warn { margin-top: 6px; color: #ffd37a; font-size: 11px; display: none; }
    .warn.on { display: block; }
    .note { display: none; color: #ffd37a; font-size: 11px; }
    :host(.blind) .note { display: block; }
    :host(.blind) .stats { display: none; }
  `;

  const badge = (() => {
    const host = document.createElement('div');
    host.id = 'tld-badge';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="pill" title="Click to jump to live">
        <span class="dot"></span><span class="lat">–</span><span class="rate"></span>
      </div>
      <div class="wrap"><div class="panel">
        <div class="note">Can't read latency from the Twitch player. Twitch may have changed it; check for an extension update.</div>
        <div class="stats">
        <canvas width="472" height="112"></canvas>
        <div class="legend"><span><i style="background:#bf94ff"></i>Latency</span><span><i style="background:#7d7d8a"></i>Buffer</span><span><i style="background:#00f593"></i>Target</span></div>
        <div class="row"><span>Latency to broadcaster</span><b data-k="lat"></b></div>
        <div class="row"><span>Buffer</span><b data-k="buf"></b></div>
        <div class="row"><span>Playback speed</span><b data-k="rate"></b></div>
        <div class="row"><span>Catch-up</span><b data-k="mode"></b></div>
        <div class="row"><span>Stalls this session</span><b data-k="stalls"></b></div>
        <div class="warn">Low-latency mode looks off. Turn it on in the player's Settings › Advanced.</div>
        <div class="hint">Click the badge to jump to live.</div>
        </div>
      </div></div>`;

    const $ = (s) => root.querySelector(s);
    const dot = $('.dot'), latEl = $('.lat'), rateEl = $('.rate'), warn = $('.warn'), canvas = $('canvas');
    const fields = Object.fromEntries([...root.querySelectorAll('[data-k]')].map((e) => [e.dataset.k, e]));
    const ctx = canvas.getContext('2d');
    let hovering = false;
    const text = (el, v) => { if (el.textContent !== v) el.textContent = v; };

    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    $('.pill').addEventListener('click', jumpToLive);
    host.addEventListener('mouseenter', () => { hovering = true; });
    host.addEventListener('mouseleave', () => { hovering = false; });

    function mount() {
      const v = st.video;
      if (!v) return false;
      const parent = v.closest('.video-player__container') || v.closest('[data-a-target="video-player"]') || v.parentElement;
      if (parent && host.parentNode !== parent) parent.appendChild(host);
      return !!parent;
    }

    function drawGraph() {
      const W = canvas.width, H = canvas.height, h = st.hist;
      ctx.clearRect(0, 0, W, H);
      if (h.length < 2) return;
      const now = h[h.length - 1].t;
      const target = S.mode === 'target' ? S.targetLatency : null;
      let max = Math.max(2, target ?? 0, ctl.bufTarget);
      for (const p of h) max = Math.max(max, p.lat, p.buf);
      max *= 1.15;
      const x = (t) => W - ((now - t) / HISTORY_MS) * W;
      const y = (v) => H - 2 - (v / max) * (H - 4);

      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(0,245,147,.7)';
      const ty = y(target ?? ctl.bufTarget);
      ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke();
      ctx.setLineDash([]);

      for (const [key, color] of [['buf', '#7d7d8a'], ['lat', '#bf94ff']]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = key === 'lat' ? 3 : 2;
        ctx.beginPath();
        h.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p[key])) : ctx.moveTo(x(p.t), y(p[key]))));
        ctx.stroke();
      }
      ctx.fillStyle = '#adadb8';
      ctx.font = '20px sans-serif';
      ctx.fillText(`${max.toFixed(1)}s`, 4, 20);
    }

    function render() {
      const s = st.snap;
      const blind = st.blind && !s?.live;
      if (!S.showBadge || !(s?.live || blind) || !mount()) {
        if (host.isConnected) host.remove();
        return;
      }
      host.classList.toggle('blind', blind);
      if (blind) {
        text(latEl, '?');
        dot.className = 'dot';
        rateEl.classList.remove('on');
        return;
      }
      text(latEl, s.lat < 10 ? `${s.lat.toFixed(1)}s` : `${Math.round(s.lat)}s`);
      dot.className = `dot ${s.lat <= 2.5 ? 'good' : s.lat <= 5 ? 'ok' : 'bad'}`;
      const speeding = ctl.rate > 1.004;
      rateEl.classList.toggle('on', speeding);
      if (speeding) text(rateEl, `${ctl.rate.toFixed(2)}×`);

      if (!hovering) return;
      text(fields.lat, `${s.lat.toFixed(2)} s`);
      text(fields.buf, `${s.buf.toFixed(2)} s`);
      text(fields.rate, `${ctl.rate.toFixed(2)}×`);
      text(fields.mode, !S.catchUp ? 'Off'
        : S.mode === 'target' ? `Target ${S.targetLatency}s`
        : `Lowest (buffer ${ctl.bufTarget.toFixed(2)}s)`);
      text(fields.stalls, String(st.stalls));
      warn.classList.toggle('on', s.lowLatency === false);
      drawGraph();
    }

    return { render };
  })();

  setInterval(tick, C.TICK_MS);
})();
