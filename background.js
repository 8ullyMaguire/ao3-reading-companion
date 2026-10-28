// background.js — the background context after §48.
//
// Upstream this file was the AO3 scraping engine: alarms, listing scrapes, subscription
// syncs, a login check, and a message API driven by a content script. §48.2 moves the
// ranking to the instance and §48.4 makes the extension a client, so none of that has a
// consumer: the numbers the extension shows now come from the server's own payloads.
//
// What is left is what a client still needs: default settings on install, and the feed page
// — which serves its own setup form — on first install.
console.log('[Darkhold] Background script loaded.');

browser.runtime.onInstalled.addListener(async (details) => {
  try {
    const { created } = await ensureDefaultSettings();
    if (created || details.reason === 'install') {
      browser.tabs.create({ url: browser.runtime.getURL('feed.html') });
    }
  } catch (e) {
    console.error('[Darkhold] install setup failed:', e);
  }
});
