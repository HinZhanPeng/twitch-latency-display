# Chrome Web Store Listing — Latency Catch-Up for Twitch

> Last Updated: 2026-11-09

Copy-paste source for the Chrome Web Store Developer Dashboard. Not shipped in the package.

## Store Listing

**Extension Name**
Latency Catch-Up for Twitch

**Short Description** (matches manifest, ≤ 132 chars)
Shows live stream latency on the Twitch player and automatically catches up to the live edge.

**Detailed Description**

```
See exactly how far behind live you are on any Twitch stream, and get back to the live edge automatically.

FEATURES
• Latency badge on the player: shows your delay to the broadcaster, colour-coded green, yellow or red. Hover for a 60-second graph; click to jump straight to live.
• Auto catch-up: when you fall behind, playback speeds up slightly (1.15× by default, pitch preserved) until you're back at the edge, then returns to normal speed. If you're more than 6 seconds behind, it jumps ahead instead.
• Lowest-possible mode: learns the smallest buffer your connection can hold without stalling, and adjusts itself if the stream starts to buffer.
• Fixed-target mode: keeps your delay near a number you choose.
• Works on both low-latency and normal-latency streams.
• Popout chat shows a small latency indicator for the stream you're watching.

HOW TO USE
1. Install the extension and open any live stream on twitch.tv.
2. The latency badge appears in the top-left corner of the player.
3. Click the extension icon to turn catch-up on or off, choose a mode, or set the maximum speed.
Tip: for the lowest delay, turn on Low Latency in the Twitch player's Settings › Advanced.

PRIVACY
This extension only runs on twitch.tv. It does not collect, send or sell any data. Your settings are saved in your browser (and synced with your Chrome profile if you use Chrome sync).

This extension is not affiliated with or endorsed by Twitch Interactive, Inc.

FEEDBACK
Report problems or request features at https://github.com/HinZhanPeng/twitch-latency-display/issues
```

**Category**
Lifestyle → Entertainment

**Single Purpose**
Displays live-stream latency on the Twitch video player and adjusts playback speed to keep the viewer close to the live broadcast.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `extension/icons/icon-128.png` |
| Screenshot 1 | 1280×800 | ✅ Ready | `store-assets/screenshot-1-badge.png` |
| Screenshot 2 | 1280×800 | ✅ Ready | `store-assets/screenshot-2-graph.png` |
| Screenshot 3 | 1280×800 | ✅ Ready | `store-assets/screenshot-3-settings.png` |
| Small Promo Tile | 440×280 | ⬜ Not created | |

### Screenshot Notes
1. A live stream with the latency badge visible in the player corner (green, low latency).
2. The badge hover graph showing latency/buffer over 60 s, ideally during a catch-up (speed shown).
3. The settings popup open next to the player.

Screenshots 1 and 2 are captured from Topson's live Dota 2 stream (2026-11-09). If a reviewer
objects to third-party stream content, retake them on your own stream.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves the user's settings from the popup (catch-up on/off, lowest-possible vs fixed-target mode, target latency, maximum speed, badge visibility) so they persist across sessions and apply to every Twitch tab. |
| `https://www.twitch.tv/*` | content_scripts matches (host access) | The extension's only function is on the Twitch video player: it reads the player's current latency and buffer to draw the latency badge, and adjusts playback speed to catch up to live. It runs on no other site. |

**Remote code:** No. All JavaScript is bundled in the package.

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | — | — | No |
| Health info | No | — | — | No |
| Financial info | No | — | — | No |
| Authentication info | No | — | — | No |
| Personal communications | No | — | — | No |
| Location | No | — | — | No |
| Web history | No | — | — | No |
| User activity | No | — | — | No |
| Website content | No | — | — | No |

Notes for accuracy:
- Settings are stored with Chrome's sync storage, so Chrome itself syncs them across the user's signed-in browsers. The developer never receives them.
- The learned minimum buffer (one number for low-latency streams, one for normal) is kept in the twitch.tv page's local storage on the user's device.
- The extension makes no network requests of its own.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**
https://github.com/HinZhanPeng/twitch-latency-display/blob/main/PRIVACY.md
(Only works once the repo is public and `PRIVACY.md` is pushed. Open the link in a private window to check before you submit.)

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name**: Hin Zhan Peng
**Contact Email**: _fill in. This is shown publicly, so consider a dedicated address._
**Support URL**: https://github.com/HinZhanPeng/twitch-latency-display/issues
**Homepage URL**: https://github.com/HinZhanPeng/twitch-latency-display

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-11-09 | First release: latency badge with graph, auto catch-up, lowest-possible and fixed-target modes, popout chat indicator. | Draft |

## Review Notes

### Known Issues / Limitations
- The extension relies on Twitch's internal player. A Twitch update can break it until a new version ships.
- The name uses "Twitch" in the "for Twitch" form and the description includes a non-affiliation line. If a reviewer flags trademark use, rename to something like "Stream Latency Catch-Up" and keep "Twitch" only in the description.

### Rejection History
_None yet._
