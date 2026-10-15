// popup.js — the popup's whole job after §48: say which instance this extension talks to,
// and open the feed. There is no cache to count and no setup to run in here any more: the
// feed page serves its own setup form, so an unconfigured reader is one click away from it.
console.log('[Lorehaven] Popup opened.');

function openInTab(htmlPath) {
  browser.tabs.create({ url: browser.runtime.getURL(htmlPath) });
  window.close();
}

(async function () {
  const statusEl = document.getElementById('status');
  const instanceValue = document.getElementById('instance-value');
  const feedBtn = document.getElementById('open-lorehaven');
  const refreshBtn = document.getElementById('refresh-cache');

  let instance = '';
  try {
    instance = (await getInstance()) || '';
  } catch (e) {
    console.error('[Lorehaven] popup could not read settings:', e);
    statusEl.textContent = 'Could not read this extension\'s settings.';
    return;
  }

  instanceValue.textContent = instance || 'not configured';
  instanceValue.classList.toggle('warn', !instance);
  if (instance) {
    statusEl.textContent = 'Recommendations come from this instance.';
    refreshBtn.hidden = false;
  } else {
    statusEl.classList.add('warn');
    statusEl.textContent = 'No instance yet — open the feed and set one.';
  }

  feedBtn.addEventListener('click', () => openInTab('feed.html'));
  refreshBtn.addEventListener('click', async () => {
    try {
      const all = await browser.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('lh:'));
      if (keys.length) await browser.storage.local.remove(keys);
      statusEl.textContent = keys.length
        ? `Cleared ${keys.length} cached answer${keys.length === 1 ? '' : 's'}.`
        : 'Nothing cached yet.';
    } catch (e) {
      statusEl.textContent = 'Could not clear the cache.';
      console.error(e);
    }
  });
})();
