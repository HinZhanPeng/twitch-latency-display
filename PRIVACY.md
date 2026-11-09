# Privacy Policy: Latency Catch-Up for Twitch

Last updated: 2026-11-09

## What data we collect

None. Latency Catch-Up for Twitch does not collect, record, or send any personal data,
browsing history, or viewing activity to the developer or to anyone else.

## What the extension stores on your device

- **Your settings** (auto catch-up on/off, mode, target latency, maximum speed, badge
  visibility). These are saved with Chrome's built-in extension storage. If you use Chrome
  sync, Chrome syncs these settings between your own signed-in browsers under
  [Google's privacy policy](https://policies.google.com/privacy). The developer never sees them.
- **A learned buffer size** (one number for low-latency streams and one for normal streams),
  saved in your browser's local storage for twitch.tv so the extension remembers what your
  connection can handle.

## Where the extension runs

Only on `https://www.twitch.tv/`. It reads the video player's latency and buffer to show the
badge and adjust playback speed. It does not read chat, your account, or any other page content.

## Third-party services and sharing

The extension makes no network requests of its own and uses no analytics or third-party
services. No data is shared or sold.

## Deleting your data

Click **Reset learned buffer** in the extension popup to clear the learned buffer sizes.
Removing the extension deletes its saved settings.

## Changes to this policy

If this policy changes, the new version will be posted at this address with an updated date.

## Contact

Open an issue at https://github.com/HinZhanPeng/twitch-latency-display/issues
