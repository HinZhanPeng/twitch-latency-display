'use strict';

const DEFAULTS = {
  catchUp: true,
  mode: 'lowest',
  targetLatency: 3,
  maxRate: 1.15,
  showBadge: true,
  resetToken: 0,
};

const $ = (id) => document.getElementById(id);
const els = {
  catchUp: $('catchUp'),
  targetLatency: $('targetLatency'),
  maxRate: $('maxRate'),
  maxRateOut: $('maxRateOut'),
  showBadge: $('showBadge'),
  modeSet: $('modeSet'),
  status: $('status'),
};

let statusTimer;
function flash(msg) {
  els.status.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { els.status.textContent = ''; }, 1500);
}

async function save(patch) {
  try {
    await chrome.storage.sync.set(patch);
    flash('Saved');
  } catch (err) {
    flash('Could not save');
    console.error(err);
  }
}

function paint(s) {
  els.catchUp.checked = s.catchUp;
  els.showBadge.checked = s.showBadge;
  els.targetLatency.value = s.targetLatency;
  els.maxRate.value = s.maxRate;
  els.maxRateOut.textContent = `${Number(s.maxRate).toFixed(2)}×`;
  els.modeSet.disabled = !s.catchUp;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  paint(s);

  els.catchUp.addEventListener('change', () => {
    els.modeSet.disabled = !els.catchUp.checked;
    save({ catchUp: els.catchUp.checked });
  });
  els.showBadge.addEventListener('change', () => save({ showBadge: els.showBadge.checked }));
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.addEventListener('change', () => r.checked && save({ mode: r.value }));
  }
  els.targetLatency.addEventListener('change', () => {
    const v = Math.min(30, Math.max(1, Number(els.targetLatency.value) || DEFAULTS.targetLatency));
    els.targetLatency.value = v;
    save({ targetLatency: v, mode: 'target' });
    for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === 'target';
  });
  els.maxRate.addEventListener('input', () => {
    els.maxRateOut.textContent = `${Number(els.maxRate.value).toFixed(2)}×`;
  });
  els.maxRate.addEventListener('change', () => save({ maxRate: Number(els.maxRate.value) }));
  $('reset').addEventListener('click', async () => {
    await chrome.storage.sync.set({ resetToken: Date.now() });
    flash('Buffer target reset');
  });
}

init().catch((err) => {
  console.error(err);
  flash('Failed to load settings');
});
