// Catch-up controller: the decision logic only, with no DOM access, so it can be
// simulated in Node (test/controller.test.js). The manifest loads this right before
// page.js in the page's MAIN world; page.js takes the export and removes the global.
(() => {
  'use strict';

  const C = Object.freeze({
    TICK_MS: 250,
    MAX_TICK_GAP_MS: 2000,      // ticks further apart than this (throttled tab): hold 1×

    BUF_FLOOR: 0.4,             // never aim for less buffer than this (s)
    BUF_CEIL: 4,                // adaptive target never grows past this (s)
    BUF_START: 0.8,             // first guess before anything is learned (s)
    STALL_PENALTY: 0.3,         // buffer added to the target after a stall (s)
    STALL_COOLDOWN_MS: 10_000,  // no catch-up right after a stall
    DECAY_STEP: 0.05,           // buffer trimmed from the target per quiet period (s)
    DECAY_EVERY_MS: 30_000,
    FAILED_MEMORY_MS: 10 * 60_000, // after a stall, stay above the failed level this long

    // Normal-latency streams arrive in ~2 s chunks, so the buffer is a sawtooth
    // (e.g. 2.2 → 0.3 → 2.2 s). Control on its low point over this window, not
    // on the instantaneous value, or catch-up drains the trough into a stall.
    TROUGH_WINDOW_MS: 8000,

    ENGAGE_AT: 0.25,            // start speeding up when this far over target (s)
    RELEASE_AT: 0.03,           // stop once within this of target (s)
    BIG_GAP: 6,                 // further behind than this: seek instead of speeding (s)
    SEEK_EVERY_MS: 5000,        // at most one catch-up seek per this long
    SLEW_UP: 0.02,              // max rate increase per TICK_MS
    SLEW_DOWN: 0.05,            // max rate decrease per TICK_MS
  });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function createController({ bufTarget = C.BUF_START, now = 0 } = {}) {
    return {
      bufTarget,                // learned minimum buffer (s)
      bufHist: [],              // recent {t, buf} for the trough
      engaged: false,
      rate: 1,
      failedAt: 0,              // target in force at the last stall
      lastStall: -Infinity,
      lastDecay: now,

      release() {
        this.engaged = false;
        this.rate = 1;
      },

      trough(now, buf) {
        this.bufHist.push({ t: now, buf });
        while (this.bufHist.length && now - this.bufHist[0].t > C.TROUGH_WINDOW_MS) this.bufHist.shift();
        let low = buf;
        for (const p of this.bufHist) if (p.buf < low) low = p.buf;
        return low;
      },

      // A real stall happened. Returns true when the learned target changed.
      stall(now, catchUp) {
        this.lastStall = now;
        if (!catchUp) return false;
        this.failedAt = this.bufTarget;   // this level was too low; don't trim back to it soon
        this.bufTarget = Math.min(C.BUF_CEIL, this.bufTarget + C.STALL_PENALTY);
        this.release();
        return true;
      },

      // One control tick. `playing` = live and not paused; `dt` = ms since the last tick.
      // Afterwards `this.rate` is the speed to apply, unless `seek` (seconds to skip
      // ahead) is non-zero. `targetChanged` means the learned target should be saved.
      step({ now, dt, lat, buf, playing, lastSeek = -Infinity }, S) {
        const out = { seek: 0, targetChanged: false };
        const low = this.trough(now, buf);
        if (!S.catchUp || !playing || dt > C.MAX_TICK_GAP_MS) {
          this.lastDecay = now;
          this.release();
          return out;
        }
        if (now - this.lastStall < C.STALL_COOLDOWN_MS) { this.release(); return out; }

        // Trim the target only after a quiet period spent *at* the target. A buffer
        // sitting well above it (fixed-target mode, or still catching up) proves nothing.
        if (low - this.bufTarget > C.ENGAGE_AT) {
          this.lastDecay = now;
        } else if (now - this.lastStall > C.DECAY_EVERY_MS && now - this.lastDecay > C.DECAY_EVERY_MS) {
          this.lastDecay = now;
          const floor = now - this.lastStall < C.FAILED_MEMORY_MS
            ? Math.max(C.BUF_FLOOR, this.failedAt + 0.1)
            : C.BUF_FLOOR;
          const next = Math.max(Math.min(floor, this.bufTarget), this.bufTarget - C.DECAY_STEP);
          if (next !== this.bufTarget) { this.bufTarget = next; out.targetChanged = true; }
        }

        // How far behind are we? Measured on the buffer's low point, and in both modes
        // that low point must never be pushed under the learned minimum.
        const overBuffer = low - this.bufTarget;
        const excess = S.mode === 'target' ? Math.min(lat - S.targetLatency, overBuffer) : overBuffer;

        if (excess > C.BIG_GAP && now - lastSeek > C.SEEK_EVERY_MS) { out.seek = excess; return out; }

        if (!this.engaged && excess > C.ENGAGE_AT) this.engaged = true;
        else if (this.engaged && excess <= C.RELEASE_AT) this.engaged = false;

        const want = this.engaged ? 1 + clamp(0.04 + excess * 0.12, 0, S.maxRate - 1) : 1;
        const k = Math.max(0, dt) / C.TICK_MS;         // slew per unit of time, not per tick
        this.rate = buf < this.bufTarget * 0.6
          ? 1                                          // buffer is thin: back off right away
          : clamp(want, this.rate - C.SLEW_DOWN * k, this.rate + C.SLEW_UP * k);
        if (Math.abs(this.rate - 1) < 0.004) this.rate = 1;
        return out;
      },
    };
  }

  const api = { C, createController };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.__tldController = api;
})();
