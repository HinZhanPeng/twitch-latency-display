# Latency Catch-Up for Twitch

Chrome extension (Manifest V3) that shows live latency on the Twitch player and
automatically catches up to the live edge.

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Disable the old **Twitch Latency Display** extension: it clicks through the player
   settings menu every time the stats overlay closes and will fight with this one.
4. Reload any open Twitch tabs.

For the lowest latency, turn on **Low Latency** in the Twitch player's Settings › Advanced.

## What it does

- **Badge** in the top-left of the player: latency to broadcaster, colour-coded
  (green ≤ 2.5 s, yellow ≤ 5 s, red above), plus the current speed while catching up.
  Hover for a 60-second graph of latency/buffer and details. Click to jump to live.
- **Auto catch-up** (on by default): when you are behind, playback speeds up gently
  (default max 1.15×, pitch preserved) until you're back at the edge, then returns to 1×.
  More than 6 s behind, it seeks instead.
- **Lowest-possible mode** (default) shrinks the buffer toward a learned minimum. Every
  stall adds 0.3 s to that minimum and pauses catch-up for 10 s; every 30 s without a stall
  trims 0.05 s off (floor 0.4 s). Low-latency and normal streams each have their own
  learned value, kept per browser in `localStorage`.
- **Normal-latency streams** deliver video in ~2 s chunks, so the buffer swings up and
  down. Catch-up works from the lowest point of the buffer over the last 8 s, so it
  never drains a dip into a stall.
- **Fixed-target mode**: holds latency near a number you choose (still never drains the
  buffer below the learned minimum).
- **Popout chat** shows a small latency pill fed from the player tab.

## How it works

- `content/page.js` runs in the page's main world. It finds Twitch's player object through
  the React tree (`mediaPlayerInstance` prop) and reads `getLiveLatency()` /
  `getBufferDuration()` directly, so there is no DOM scraping, no menu clicking, and no
  dependence on the UI language.
- Twitch's player core (in a web worker) resets `video.playbackRate` to 1× on live streams
  within milliseconds, and its own `setPlaybackRate` is ignored for live. While catch-up is
  active, the script shadows `playbackRate` on that one `<video>` element and drops the
  core's writes. It removes the shadow as soon as speed is back to 1×, so Twitch regains
  full control.
- `content/bridge.js` (isolated world) passes settings from `chrome.storage.sync` to the page.
- `popup/` holds the settings UI.

## Caveat

The player hooks (`mediaPlayerInstance`, `getLiveLatency`, the worker's rate resets) are
Twitch internals. They were verified working on 2026-11-08, but a Twitch player update could
change them. If the badge stops appearing, start by checking `findPlayer()` in `page.js`.
