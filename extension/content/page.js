// Runs in the page's MAIN world so it can reach Twitch's player object.
(() => {
  'use strict';
  if (window.__tldLoaded) return;
  window.__tldLoaded = true;

  // ---------------------------------------------------------------- config
  const TICK_MS = 250;
  const HISTORY_MS = 60_000;
  const LOOKUP_EVERY_MS = 4000;

  const BUF_FLOOR = 0.4;        // never aim for less buffer than this (s)
  const BUF_CEIL = 4;           // adaptive target never grows past this (s)
  const BUF_START = 0.8;        // first guess before anything is learned (s)
  const STALL_PENALTY = 0.3;    // buffer added to the target after a stall (s)
  const STALL_COOLDOWN_MS = 10_000; // no catch-up right after a stall
  const DECAY_STEP = 0.05;      // buffer trimmed from the target per quiet period (s)
  const DECAY_EVERY_MS = 30_000;
  const FAILED_MEMORY_MS = 10 * 60_000; // after a stall, stay above the failed level this long

  // Normal-latency streams arrive in ~2 s chunks, so the buffer is a sawtooth
  // (e.g. 2.2 → 0.3 → 2.2 s). Control on its low point over this window, not
  // on the instantaneous value, or catch-up drains the trough into a stall.
  const TROUGH_WINDOW_MS = 8000;

  const ENGAGE_AT = 0.25;       // start speeding up when this far over target (s)
  const RELEASE_AT = 0.03;      // stop once within this of target (s)
  const BIG_GAP = 6;            // further behind than this: seek instead of speeding (s)
  const SLEW_UP = 0.02;         // max rate increase per tick
  const SLEW_DOWN = 0.05;       // max rate decrease per tick

  const CHANNEL = 'twitch-latency-display';
  // Learned separately: low-latency and normal streams need very different buffers.
  const storeKey = (ll) => (ll ? 'tld.bufTarget.ll' : 'tld.bufTarget.std');

  let S = { catchUp: true, mode: 'lowest', targetLatency: 3, maxRate: 1.15, showBadge: true, resetToken: 0 };

  const st = {
    mp: null,
    lastLookup: -Infinity,
    video: null,
    rate: 1,
    engaged: false,
    weSetRate: false,
    ll: true,                 // is the current stream low-latency?
    bufTarget: loadBufTarget(true),
    bufHist: [],              // recent {t, buf} for the trough
    prevState: null,
    failedAt: 0,
    lastStall: -Infinity,
    lastDecay: performance.now(),
    lastSeek: -Infinity,
    lastPlay: -Infinity,
    stalls: 0,
    hist: [],
    snap: null,
  };

  // ---------------------------------------------------------------- settings
  let settingsLoaded = false;
  document.addEventListener('tld:settings', (e) => {
    try {
      const next = JSON.parse(e.detail);
      const wasLoaded = settingsLoaded;
      settingsLoaded = true;
      if (wasLoaded && next.resetToken !== S.resetToken) {
        try {
          localStorage.removeItem(storeKey(true));
          localStorage.removeItem(storeKey(false));
        } catch { /* storage blocked */ }
        st.bufTarget = BUF_START;
        st.stalls = 0;
      }
      S = { ...S, ...next };
      if (!S.catchUp) release();
    } catch { /* ignore malformed */ }
  });
  document.dispatchEvent(new CustomEvent('tld:request-settings'));

  function loadBufTarget(ll) {
    try {
      const v = Number(localStorage.getItem(storeKey(ll)));
      if (v >= BUF_FLOOR && v <= BUF_CEIL) return v;
    } catch { /* storage blocked */ }
    return BUF_START;
  }
  function saveBufTarget() {
    try { localStorage.setItem(storeKey(st.ll), st.bufTarget.toFixed(2)); } catch { /* storage blocked */ }
  }

  // ---------------------------------------------------------------- helpers
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  function call(obj, name) {
    try {
      const fn = obj?.[name];
      return typeof fn === 'function' ? fn.call(obj) : undefined;
    } catch { return undefined; }
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
    st.engaged = false;
    st.rate = 1;
    if (st.weSetRate) setRate(1);
  }

  function seekBy(seconds) {
    const v = st.video;
    if (!v) return;
    const end = bufferedEnd(v);
    if (end === undefined) return;
    const to = Math.min(v.currentTime + seconds, end - st.bufTarget);
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
    st.lastSeek = performance.now();
    if (v.paused) v.play().catch(() => {});
    v.currentTime = Math.max(v.currentTime, end - st.bufTarget);
  }

  function onPlay() { st.lastPlay = performance.now(); }

  // Called from the <video> 'waiting' event and from the player entering 'Buffering'
  // (Twitch sometimes recovers a stall by restarting at live without 'waiting').
  function registerStall() {
    const now = performance.now();
    if (now - st.lastStall < 3000) return;         // same stall reported twice
    if (now - st.lastSeek < 2000) return;          // our own seek, not a real stall
    if (now - st.lastPlay < 3000) return;          // normal refill after resuming from pause
    if (!st.snap?.live || st.video?.paused) return;
    st.stalls++;
    st.lastStall = now;
    if (S.catchUp) {
      st.failedAt = st.bufTarget;                  // this level was too low; don't trim back to it soon
      st.bufTarget = Math.min(BUF_CEIL, st.bufTarget + STALL_PENALTY);
      saveBufTarget();
      release();
    }
  }
  const onWaiting = registerStall;

  function trough(now, buf) {
    st.bufHist.push({ t: now, buf });
    while (st.bufHist.length && now - st.bufHist[0].t > TROUGH_WINDOW_MS) st.bufHist.shift();
    let low = buf;
    for (const p of st.bufHist) if (p.buf < low) low = p.buf;
    return low;
  }

  function control(now, lat, buf) {
    const low = trough(now, buf);
    if (!S.catchUp || !st.snap.live || st.video.paused) { release(); return; }
    if (now - st.lastStall < STALL_COOLDOWN_MS) { release(); return; }

    if (now - st.lastStall > DECAY_EVERY_MS && now - st.lastDecay > DECAY_EVERY_MS) {
      st.lastDecay = now;
      const floor = now - st.lastStall < FAILED_MEMORY_MS ? Math.max(BUF_FLOOR, st.failedAt + 0.1) : BUF_FLOOR;
      const next = Math.max(Math.min(floor, st.bufTarget), st.bufTarget - DECAY_STEP);
      if (next !== st.bufTarget) { st.bufTarget = next; saveBufTarget(); }
    }

    // How far behind are we? Measured on the buffer's low point, and in both modes
    // that low point must never be pushed under the learned minimum.
    const overBuffer = low - st.bufTarget;
    const excess = S.mode === 'target' ? Math.min(lat - S.targetLatency, overBuffer) : overBuffer;

    if (excess > BIG_GAP && now - st.lastSeek > 5000) { seekBy(excess); return; }

    if (!st.engaged && excess > ENGAGE_AT) st.engaged = true;
    else if (st.engaged && excess <= RELEASE_AT) st.engaged = false;

    const want = st.engaged ? 1 + clamp(0.04 + excess * 0.12, 0, S.maxRate - 1) : 1;
    st.rate = buf < st.bufTarget * 0.6
      ? 1                                            // buffer is thin: back off right away
      : clamp(want, st.rate - SLEW_DOWN, st.rate + SLEW_UP);
    if (Math.abs(st.rate - 1) < 0.004) st.rate = 1;
    setRate(st.rate);
  }

  // ---------------------------------------------------------------- main loop
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
  const channelName = () => (location.pathname.split('/')[1] || '').toLowerCase();

  function tick() {
    const now = performance.now();

    if (!st.mp || now - st.lastLookup > LOOKUP_EVERY_MS) {
      st.lastLookup = now;
      const mp = findPlayer();
      if (mp !== st.mp) { st.mp = mp; st.engaged = false; }
    }

    const video = pickVideo(st.mp);
    if (video !== st.video) {
      st.video?.removeEventListener('waiting', onWaiting);
      st.video?.removeEventListener('play', onPlay);
      if (st.weSetRate && st.video) nativeRate.set.call(st.video, 1);
      unlockRate(st.video);
      st.weSetRate = false;
      st.rate = 1;
      st.bufHist = [];
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
      st.bufTarget = loadBufTarget(ll);
      st.bufHist = [];
      release();
    }

    const state = call(st.mp, 'getState');
    if (st.prevState === 'Playing' &&
        (state === 'Buffering' || (state === 'Idle' && st.weSetRate))) registerStall();
    st.prevState = state;

    st.snap = { live, lat, buf, lowLatency, paused: !!video?.paused };

    if (video && lat !== undefined && buf !== undefined) control(now, lat, buf);
    else release();

    if (live) {
      st.hist.push({ t: now, lat, buf });
      while (st.hist.length && now - st.hist[0].t > HISTORY_MS) st.hist.shift();
      bc?.postMessage({ channel: channelName(), lat, buf, rate: st.rate });
    }

    badge.render();
  }

  // ---------------------------------------------------------------- badge UI
  const CSS = `
    :host { all: initial; position: absolute; top: 10px; left: 10px; z-index: 1000;
      font-family: Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif; }
    .pill { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
      background: rgba(14,14,16,.72); backdrop-filter: blur(6px); color: #efeff1;
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
        <canvas width="472" height="112"></canvas>
        <div class="legend"><span><i style="background:#bf94ff"></i>Latency</span><span><i style="background:#7d7d8a"></i>Buffer</span><span><i style="background:#00f593"></i>Target</span></div>
        <div class="row"><span>Latency to broadcaster</span><b data-k="lat"></b></div>
        <div class="row"><span>Buffer</span><b data-k="buf"></b></div>
        <div class="row"><span>Playback speed</span><b data-k="rate"></b></div>
        <div class="row"><span>Catch-up</span><b data-k="mode"></b></div>
        <div class="row"><span>Stalls this session</span><b data-k="stalls"></b></div>
        <div class="warn">Low-latency mode looks off. Turn it on in the player's Settings › Advanced.</div>
        <div class="hint">Click the badge to jump to live.</div>
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
      let max = Math.max(2, target ?? 0, st.bufTarget);
      for (const p of h) max = Math.max(max, p.lat, p.buf);
      max *= 1.15;
      const x = (t) => W - ((now - t) / HISTORY_MS) * W;
      const y = (v) => H - 2 - (v / max) * (H - 4);

      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(0,245,147,.7)';
      const ty = y(target ?? st.bufTarget);
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
      if (!S.showBadge || !s?.live || !mount()) {
        if (host.isConnected) host.remove();
        return;
      }
      text(latEl, s.lat < 10 ? `${s.lat.toFixed(1)}s` : `${Math.round(s.lat)}s`);
      dot.className = `dot ${s.lat <= 2.5 ? 'good' : s.lat <= 5 ? 'ok' : 'bad'}`;
      const speeding = st.rate > 1.004;
      rateEl.classList.toggle('on', speeding);
      if (speeding) text(rateEl, `${st.rate.toFixed(2)}×`);

      if (!hovering) return;
      text(fields.lat, `${s.lat.toFixed(2)} s`);
      text(fields.buf, `${s.buf.toFixed(2)} s`);
      text(fields.rate, `${st.rate.toFixed(2)}×`);
      text(fields.mode, !S.catchUp ? 'Off'
        : S.mode === 'target' ? `Target ${S.targetLatency}s`
        : `Lowest (buffer ${st.bufTarget.toFixed(2)}s)`);
      text(fields.stalls, String(st.stalls));
      warn.classList.toggle('on', s.lowLatency === false);
      drawGraph();
    }

    return { render };
  })();

  // ---------------------------------------------------------------- popout chat
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
      if (!d || d.channel !== want) return;
      el.textContent = `${d.lat.toFixed(1)}s${d.rate > 1.004 ? ` · ${d.rate.toFixed(2)}×` : ''}`;
      el.style.display = 'block';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
    });
    return; // popout chat has no player to control
  }

  setInterval(tick, TICK_MS);
})();
