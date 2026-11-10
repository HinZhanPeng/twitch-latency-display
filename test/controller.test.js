// Run with: npm test   (or: node --test)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { C, createController } = require('../extension/content/controller.js');

const LOWEST = { catchUp: true, mode: 'lowest', targetLatency: 3, maxRate: 1.15 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Minimal player model. Media arrives at 1 s per second, either smoothly (chunk = 0,
// like a low-latency stream) or in `chunk`-second pieces (normal streams: a sawtooth
// buffer). The playhead moves at the controller's rate; running dry is a stall that
// takes a second to recover from.
function simulate({ ctl, S, seconds, startBuf, chunk = 0, upstream = 1, tickMs = C.TICK_MS }) {
  const SUB_MS = 50;
  let head = 0, stalls = 0, maxRate = 1, stalledUntil = -1, lastSeek = -Infinity, lastTick = 0;
  let minBufTail = Infinity; // lowest buffer over the last 20 s of the run
  let buf = startBuf;

  for (let ms = SUB_MS; ms <= seconds * 1000; ms += SUB_MS) {
    const t = ms / 1000;
    const smoothEnd = startBuf + t;
    const end = chunk ? startBuf + Math.floor(t / chunk) * chunk : smoothEnd;

    if (ms >= stalledUntil) {
      head += ctl.rate * (SUB_MS / 1000);
      if (head >= end) {
        head = end;
        stalls++;
        stalledUntil = ms + 1000;
        ctl.stall(ms, S.catchUp);
      }
    }
    buf = end - head;
    if (ms > (seconds - 20) * 1000) minBufTail = Math.min(minBufTail, buf);

    if (ms % tickMs === 0) {
      const lat = smoothEnd + upstream - head;
      const r = ctl.step({ now: ms, dt: ms - lastTick, lat, buf, playing: ms >= stalledUntil, lastSeek }, S);
      lastTick = ms;
      if (r.seek) {
        const jump = Math.min(r.seek, buf - ctl.bufTarget);
        if (jump > 0.2) { head += jump; lastSeek = ms; }
      }
      maxRate = Math.max(maxRate, ctl.rate);
    }
  }
  return { stalls, maxRate, buf, minBufTail };
}

// Feed the controller a buffer that is held `over` seconds above its target.
function hold(ctl, S, { from, forMs, over, lat = 2, dt = C.TICK_MS }) {
  let now = from;
  for (const end = from + forMs; now < end; now += dt) {
    ctl.step({ now, dt, lat, buf: ctl.bufTarget + over, playing: true }, S);
  }
  return now;
}

test('smooth stream: drains extra buffer down to the target, then returns to 1×', () => {
  const ctl = createController({ bufTarget: 0.8 });
  const r = simulate({ ctl, S: LOWEST, seconds: 60, startBuf: 3 });
  assert.equal(r.stalls, 0);
  assert.ok(r.maxRate > 1.1 && r.maxRate <= LOWEST.maxRate + 1e-9, `max rate ${r.maxRate}`);
  assert.equal(ctl.rate, 1);
  const over = r.buf - ctl.bufTarget;
  assert.ok(over >= -0.01 && over <= C.ENGAGE_AT + C.DECAY_STEP, `buffer ends ${over.toFixed(3)} s over target`);
});

test('chunked stream: the low point of the sawtooth settles on the target without stalling', () => {
  const ctl = createController({ bufTarget: 0.8 });
  const r = simulate({ ctl, S: LOWEST, seconds: 120, startBuf: 4, chunk: 2 });
  assert.equal(r.stalls, 0);
  const over = r.minBufTail - ctl.bufTarget;
  assert.ok(over > -0.3 && over < C.ENGAGE_AT + 0.3, `sawtooth trough ends ${over.toFixed(3)} s over target`);
  assert.ok(r.minBufTail > 0.3, `trough ${r.minBufTail.toFixed(3)} s`);
});

test('far behind: asks for a seek instead of speeding up, at most once per SEEK_EVERY_MS', () => {
  const ctl = createController({ bufTarget: 0.8 });
  const first = ctl.step({ now: 1000, dt: 250, lat: 9, buf: 8, playing: true }, LOWEST);
  assert.ok(near(first.seek, 7.2), `seek ${first.seek}`);
  assert.equal(ctl.rate, 1);

  const second = ctl.step({ now: 1250, dt: 250, lat: 9, buf: 8, playing: true, lastSeek: 1000 }, LOWEST);
  assert.equal(second.seek, 0);
  assert.ok(ctl.rate > 1, 'falls back to speeding up while the seek is rate-limited');
});

test('never exceeds the max speed setting', () => {
  const ctl = createController({ bufTarget: 0.8 });
  const S = { ...LOWEST, maxRate: 1.05 };
  hold(ctl, S, { from: 0, forMs: 10_000, over: 5 });
  assert.ok(near(ctl.rate, 1.05), `rate ${ctl.rate}`);
});

test('thin buffer: backs off to 1× in a single tick', () => {
  const ctl = createController({ bufTarget: 1 });
  const now = hold(ctl, LOWEST, { from: 0, forMs: 3000, over: 2 });
  assert.ok(ctl.rate > 1.1);
  ctl.step({ now, dt: 250, lat: 2, buf: 0.5, playing: true }, LOWEST);
  assert.equal(ctl.rate, 1);
});

test('stall: raises the target, pauses catch-up, and remembers the failed level', () => {
  const ctl = createController({ bufTarget: 0.6 });
  assert.equal(ctl.stall(1000, true), true);
  assert.ok(near(ctl.bufTarget, 0.9));
  assert.ok(near(ctl.failedAt, 0.6));

  // inside the cooldown nothing engages, however full the buffer is
  hold(ctl, LOWEST, { from: 1250, forMs: C.STALL_COOLDOWN_MS - 500, over: 3 });
  assert.equal(ctl.rate, 1);
  assert.equal(ctl.engaged, false);

  // afterwards it does
  let now = hold(ctl, LOWEST, { from: 1000 + C.STALL_COOLDOWN_MS, forMs: 2000, over: 3 });
  assert.ok(ctl.rate > 1);

  // trimming stops 0.1 s above the level that stalled while the memory lasts...
  now = hold(ctl, LOWEST, { from: now, forMs: C.FAILED_MEMORY_MS - 60_000, over: 0.1 });
  assert.ok(near(ctl.bufTarget, 0.7), `target ${ctl.bufTarget}`);

  // ...and resumes toward the floor once it has expired
  hold(ctl, LOWEST, { from: now, forMs: 10 * 60_000, over: 0.1 });
  assert.ok(near(ctl.bufTarget, C.BUF_FLOOR), `target ${ctl.bufTarget}`);
});

test('stall with catch-up off: counts as a stall but leaves the learned target alone', () => {
  const ctl = createController({ bufTarget: 0.6 });
  assert.equal(ctl.stall(1000, false), false);
  assert.equal(ctl.bufTarget, 0.6);
  hold(ctl, { ...LOWEST, catchUp: false }, { from: 20_000, forMs: 5000, over: 3 });
  assert.equal(ctl.rate, 1);
});

test('trims the target by one step per quiet period while running at it', () => {
  const ctl = createController({ bufTarget: 0.8 });
  hold(ctl, LOWEST, { from: 0, forMs: C.DECAY_EVERY_MS * 2 + 1000, over: 0.1 });
  assert.ok(near(ctl.bufTarget, 0.8 - 2 * C.DECAY_STEP), `target ${ctl.bufTarget}`);
});

test('does not trim the target while the buffer sits well above it', () => {
  // fixed-target mode holding 5 s of latency: the buffer never gets near the minimum
  const ctl = createController({ bufTarget: 0.8 });
  const S = { ...LOWEST, mode: 'target', targetLatency: 5 };
  hold(ctl, S, { from: 0, forMs: 10 * 60_000, over: 3, lat: 5 });
  assert.equal(ctl.bufTarget, 0.8);
  assert.equal(ctl.rate, 1);
});

test('paused time does not count toward the quiet period', () => {
  const ctl = createController({ bufTarget: 0.8 });
  let now = 0;
  for (; now < 5 * 60_000; now += 250) {
    ctl.step({ now, dt: 250, lat: 2, buf: 0.9, playing: false }, LOWEST);
  }
  hold(ctl, LOWEST, { from: now, forMs: C.DECAY_EVERY_MS - 1000, over: 0.1 });
  assert.equal(ctl.bufTarget, 0.8);
});

test('speed ramps at the same pace per second whether ticks are 250 ms or 1 s apart', () => {
  const S = { ...LOWEST, maxRate: 1.5 };
  const fast = createController({ bufTarget: 0.8 });
  const slow = createController({ bufTarget: 0.8 });
  hold(fast, S, { from: 250, forMs: 2000, over: 3, dt: 250 });
  hold(slow, S, { from: 1000, forMs: 2000, over: 3, dt: 1000 });
  assert.ok(near(fast.rate, 1.16), `250 ms ticks: ${fast.rate}`);
  assert.ok(near(slow.rate, 1.16), `1 s ticks: ${slow.rate}`);
});

test('ticks too far apart to control safely: holds 1×', () => {
  const ctl = createController({ bufTarget: 0.8 });
  const now = hold(ctl, LOWEST, { from: 0, forMs: 3000, over: 3 });
  assert.ok(ctl.rate > 1);
  ctl.step({ now: now + 60_000, dt: 60_000, lat: 4, buf: 3.8, playing: true }, LOWEST);
  assert.equal(ctl.rate, 1);
  assert.equal(ctl.engaged, false);
});
