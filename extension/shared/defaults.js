// Default settings, shared by the popup and the isolated-world bridge.
// page.js runs in the page's MAIN world and can't load this without leaking a global
// into Twitch's page, so it keeps a starting copy that the bridge overwrites on load.
'use strict';

const DEFAULTS = Object.freeze({
  catchUp: true,
  mode: 'lowest',      // 'lowest' = adaptive minimum buffer, 'target' = fixed latency target
  targetLatency: 3,
  maxRate: 1.15,
  showBadge: true,
  resetToken: 0,
});
