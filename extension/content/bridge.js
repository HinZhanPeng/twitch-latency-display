// Isolated-world bridge: page.js (MAIN world) has no chrome.* access, so this
// script reads settings from chrome.storage and hands them over as DOM events.
// DEFAULTS comes from shared/defaults.js, loaded just before this file.
'use strict';

async function push() {
  try {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    document.dispatchEvent(new CustomEvent('tld:settings', { detail: JSON.stringify(settings) }));
  } catch (err) {
    // Extension was reloaded/updated while the tab stayed open; the old bridge is orphaned.
    console.debug('[Latency Catch-Up] settings bridge unavailable:', err);
  }
}

document.addEventListener('tld:request-settings', push);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') push();
});
push();
