// Popup script for My AO3 Algorithm.
// Phase 6: cache-aware status — distinguishes "setup not done" /
// "setup done, cache empty" / "feed ready".

console.log("[My AO3 Algorithm] Popup opened.");

function openInTab(htmlPath) {
  const url = browser.runtime.getURL(htmlPath);
  browser.tabs.create({ url });
  window.close();
}

(async function () {
  const statusEl = document.getElementById("status");
  const onboardingBtn = document.getElementById("open-onboarding");
  const feedBtn = document.getElementById("open-feed");
  const myReadingBtn = document.getElementById("open-myreading");
  const preferencesBtn = document.getElementById("open-preferences");

  let completed = false;
  let cacheCount = 0;
  try {
    const onboarding = await dbGet("preferences", "onboarding");
    completed = !!(onboarding && onboarding.completedAt);
    cacheCount = await dbCount("ficCache");
  } catch (e) {
    console.error("[My AO3 Algorithm] Popup could not read DB state:", e);
  }

  if (!completed) {
    statusEl.classList.add("warn");
    statusEl.textContent = "First-time setup hasn't finished yet. Run setup to teach the extension your tastes.";
    onboardingBtn.textContent = "Run setup";
  } else if (cacheCount === 0) {
    statusEl.classList.add("warn");
    statusEl.textContent = "No cached fics yet. Browse a tag or fandom on AO3 and your feed will fill up.";
    onboardingBtn.textContent = "Re-run setup";
    feedBtn.hidden = false;
    myReadingBtn.hidden = false;
    preferencesBtn.hidden = false;
  } else {
    statusEl.textContent = `Feed ready — ${cacheCount} fic${cacheCount === 1 ? "" : "s"} in cache.`;
    onboardingBtn.textContent = "Re-run setup";
    feedBtn.hidden = false;
    myReadingBtn.hidden = false;
    preferencesBtn.hidden = false;
  }

  feedBtn.addEventListener("click", () => openInTab("feed.html"));
  myReadingBtn.addEventListener("click", () => openInTab("myreading.html"));
  preferencesBtn.addEventListener("click", () => openInTab("preferences.html"));
  onboardingBtn.addEventListener("click", () => openInTab("onboarding.html"));
  document.getElementById("open-debug").addEventListener("click", () => openInTab("debug.html"));
})();
