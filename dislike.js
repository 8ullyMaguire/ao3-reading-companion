// dislike.js — Phase 8 "I don't like this" feedback flow.
//
// One module, three concerns:
//   1) Popover lifecycle  (open / position / fade-swap views / close)
//   2) Action application (apply changes, log to dislikeHistory, undo toast)
//   3) Pattern detection  (session-only counters → suggestion modal)
//
// Wired into feed.js by replacing the stub dislike toast with
// `openDislikePopover(item, cardEl, { onApplied })`.
//
// Module-global state, all session-scoped (resets on page reload):
//   - currentPopover  open popover ref so a second dislike click closes the
//                     first cleanly
//   - currentToast    the 10-second undo toast (one at a time)
//   - patternCounters tooLong / tooShort / per-rating tally for prompt timing
//   - patternShown    record of which pattern prompts already fired this session

(function () {

  // ---------- Constants ----------

  const TAG_DOWNWEIGHT = -5;        // "Less of it" on a tag → tag.weight -= 5
  const AUTHOR_DOWNWEIGHT = -10;    // "Less of it" on an author → manualPenalty -= 10
  const UNDO_WINDOW_MS = 10000;
  const PATTERN_THRESHOLD = 3;

  // ---------- Tiny utilities ----------

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatNumber(n) {
    if (n == null) return "?";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  // ---------- Module state ----------

  let currentPopover = null;
  let currentToast = null;
  const patternCounters = {
    too_long: 0,
    too_short: 0,
    ratings: Object.create(null)   // rating string → count
  };
  const patternShown = {
    too_long: false,
    too_short: false,
    ratings: Object.create(null)
  };

  // ---------- Popover lifecycle ----------

  function closeCurrentPopover() {
    if (currentPopover) {
      currentPopover.el.remove();
      document.removeEventListener("click", currentPopover.outsideHandler, true);
      document.removeEventListener("keydown", currentPopover.escHandler);
      window.removeEventListener("scroll", currentPopover.repositionHandler, true);
      window.removeEventListener("resize", currentPopover.repositionHandler);
      // Phase 13 R2: return focus to whichever element triggered the popover
      // (almost always the "I don't like this" button on the card) so keyboard
      // users land back where they started.
      const prev = currentPopover.previouslyFocused;
      if (prev && typeof prev.focus === "function" && document.body.contains(prev)) {
        prev.focus();
      }
      currentPopover = null;
    }
  }

  function positionPopover(popoverEl, anchorEl) {
    // Anchor under the card's right edge by default. Flip if either:
    //   - bottom would clip the viewport → flip above
    //   - right edge would clip → left-anchor instead
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = popoverEl.getBoundingClientRect();
    const margin = 8;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    let top = anchorRect.bottom + margin + window.scrollY;
    let left = anchorRect.right - popRect.width + window.scrollX;

    // Right-clip → left-anchor.
    if (left < window.scrollX + margin) {
      left = anchorRect.left + window.scrollX;
    }
    // Bottom-clip → flip above.
    if ((anchorRect.bottom + popRect.height + margin) > vpH) {
      const flippedTop = anchorRect.top - popRect.height - margin + window.scrollY;
      // Only flip if there's actually room above; otherwise stick to the bottom
      // and let the popover scroll within itself.
      if (flippedTop >= window.scrollY + margin) top = flippedTop;
    }
    // Final clamp so the popover never sits off-screen on small viewports.
    const maxLeft = window.scrollX + vpW - popRect.width - margin;
    if (left > maxLeft) left = maxLeft;
    if (left < window.scrollX + margin) left = window.scrollX + margin;

    popoverEl.style.top = `${top}px`;
    popoverEl.style.left = `${left}px`;
  }

  function buildPopoverShell() {
    const el = document.createElement("div");
    el.className = "dislike-popover";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="dislike-arrow" aria-hidden="true"></div>
      <button class="dislike-close" type="button" aria-label="Close">&times;</button>
      <div class="dislike-body"></div>
    `;
    return el;
  }

  // ---------- View 1: chip-pick ----------
  //
  // Returns the selection state object (mutable), so the chip handlers can update
  // it inline without re-rendering the whole view. The "Continue" button reads
  // from it on click.

  function renderChipView(popoverBody, fic, selection, preferredTagSet) {
    popoverBody.classList.remove("view-severity");
    popoverBody.classList.add("view-chips");
    popoverBody.innerHTML = "";

    const heading = document.createElement("h3");
    heading.className = "dislike-heading";
    heading.textContent = "What didn't work about this one?";
    popoverBody.appendChild(heading);

    const sub = document.createElement("p");
    sub.className = "dislike-sub";
    sub.textContent = "Pick anything that didn't sit right. You can choose more than one.";
    popoverBody.appendChild(sub);

    // -- Author group --
    if (fic.author) {
      const group = makeGroup("The author");
      const chip = makeChip({
        label: fic.authorPseud || fic.author,
        kind: "author",
        value: fic.author
      });
      chip.addEventListener("click", () => {
        toggleChipSelection(chip, selection.author, fic.author, "value");
      });
      group.body.appendChild(chip);
      popoverBody.appendChild(group.el);
    }

    // -- Tags group (freeform tags only) --
    const freeforms = (fic.freeformTags || []).filter(Boolean);
    if (freeforms.length > 0) {
      const group = makeGroup("The tags");
      for (const t of freeforms) {
        const isPreferred = preferredTagSet.has(String(t).toLowerCase());
        const chip = makeChip({
          label: t,
          kind: "tag",
          value: t,
          hint: isPreferred ? "in your prefs" : null
        });
        chip.addEventListener("click", () => {
          toggleChipSelection(chip, selection.tags, t, "value");
        });
        group.body.appendChild(chip);
      }
      popoverBody.appendChild(group.el);
    }

    // -- Length group (single chip; expands to too-long / too-short on click) --
    if (typeof fic.wordCount === "number" && fic.wordCount > 0) {
      const group = makeGroup("The length");
      const lengthChip = makeChip({
        label: `${formatNumber(fic.wordCount)} words`,
        kind: "length",
        value: "length"
      });
      lengthChip.addEventListener("click", () => {
        if (lengthChip.dataset.expanded === "true") return;
        lengthChip.dataset.expanded = "true";
        lengthChip.classList.add("expanded");
        const directionRow = document.createElement("div");
        directionRow.className = "dislike-length-direction";
        directionRow.innerHTML = `
          <button type="button" class="length-dir" data-dir="too_long">Too long</button>
          <button type="button" class="length-dir" data-dir="too_short">Too short</button>
        `;
        directionRow.addEventListener("click", (e) => {
          const btn = e.target.closest(".length-dir");
          if (!btn) return;
          const dir = btn.dataset.dir;
          // Single-select within the direction row.
          directionRow.querySelectorAll(".length-dir").forEach(b => b.classList.toggle("selected", b === btn));
          selection.length = { direction: dir, wordCount: fic.wordCount };
          lengthChip.classList.add("active");
        });
        group.body.appendChild(directionRow);
      });
      group.body.appendChild(lengthChip);
      popoverBody.appendChild(group.el);
    }

    // -- Rating group --
    if (fic.rating) {
      const group = makeGroup("The rating");
      const chip = makeChip({
        label: `${fic.rating} rating`,
        kind: "rating",
        value: fic.rating
      });
      chip.addEventListener("click", () => {
        const wasActive = chip.classList.contains("active");
        if (wasActive) {
          selection.rating = null;
          chip.classList.remove("active");
        } else {
          selection.rating = fic.rating;
          chip.classList.add("active");
        }
      });
      group.body.appendChild(chip);
      popoverBody.appendChild(group.el);
    }

    // -- Catch-all --
    {
      const group = makeGroup("Or maybe just");
      const chip = makeChip({
        label: "Just not feeling it right now",
        kind: "not_feeling",
        value: "not_feeling"
      });
      chip.addEventListener("click", () => {
        const wasActive = chip.classList.contains("active");
        chip.classList.toggle("active");
        selection.notFeeling = !wasActive;
      });
      group.body.appendChild(chip);
      popoverBody.appendChild(group.el);
    }

    // -- Action footer --
    const footer = document.createElement("div");
    footer.className = "dislike-footer";
    footer.innerHTML = `
      <button class="dislike-cancel" type="button">Cancel</button>
      <button class="dislike-continue primary" type="button">Continue</button>
    `;
    popoverBody.appendChild(footer);
  }

  function makeGroup(label) {
    const el = document.createElement("div");
    el.className = "dislike-group";
    const heading = document.createElement("h4");
    heading.className = "dislike-group-label";
    heading.textContent = label;
    el.appendChild(heading);
    const body = document.createElement("div");
    body.className = "dislike-group-body";
    el.appendChild(body);
    return { el, body };
  }

  function makeChip({ label, kind, value, hint }) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `dislike-chip dislike-chip-${kind}`;
    chip.dataset.kind = kind;
    chip.dataset.value = value;
    const labelSpan = document.createElement("span");
    labelSpan.className = "dislike-chip-label";
    labelSpan.textContent = label;
    chip.appendChild(labelSpan);
    if (hint) {
      const star = document.createElement("span");
      star.className = "dislike-chip-hint";
      star.textContent = `★ ${hint}`;
      chip.appendChild(star);
    }
    return chip;
  }

  // Toggles membership in a Set keyed by string value.
  function toggleChipSelection(chipEl, set, value) {
    const key = String(value).toLowerCase();
    if (set.has(key)) {
      set.delete(key);
      chipEl.classList.remove("active");
    } else {
      set.set(key, value);   // Map preserves original casing.
      chipEl.classList.add("active");
    }
  }

  // ---------- View 2: severity-pick ----------
  //
  // Per-target severity. One row per selected tag/author with radio buttons.
  // "Just from this author" is only enabled when an author is also selected
  // (it's a tag-pinned-to-author choice).

  function renderSeverityView(popoverBody, fic, selection) {
    popoverBody.classList.remove("view-chips");
    popoverBody.classList.add("view-severity");
    popoverBody.innerHTML = "";

    const heading = document.createElement("h3");
    heading.className = "dislike-heading";
    heading.textContent = "How strongly?";
    popoverBody.appendChild(heading);

    const sub = document.createElement("p");
    sub.className = "dislike-sub";
    sub.textContent = '"Less of it" gently lowers the score. "Never again" hides anything matching it.';
    popoverBody.appendChild(sub);

    const hasAuthor = selection.author.size > 0;

    // Author row.
    if (hasAuthor) {
      const authorOriginal = [...selection.author.values()][0];
      const row = makeSeverityRow({
        target: { kind: "author", value: authorOriginal },
        label: `Author: ${authorOriginal}`,
        options: [
          { value: "less", label: "Less of it" },
          { value: "never", label: "Never again" }
        ],
        defaultValue: "less"
      });
      popoverBody.appendChild(row.el);
      selection.severity.set(`author:${authorOriginal}`, row);
    }

    // Tag rows.
    for (const tagOriginal of selection.tags.values()) {
      const options = [
        { value: "less", label: "Less of it" },
        { value: "never", label: "Never again" }
      ];
      if (hasAuthor) {
        options.push({ value: "from_author", label: "Just from this author" });
      }
      const row = makeSeverityRow({
        target: { kind: "tag", value: tagOriginal },
        label: `Tag: ${tagOriginal}`,
        options,
        defaultValue: "less"
      });
      popoverBody.appendChild(row.el);
      selection.severity.set(`tag:${tagOriginal}`, row);
    }

    // Footer.
    const footer = document.createElement("div");
    footer.className = "dislike-footer";
    footer.innerHTML = `
      <button class="dislike-back" type="button">← Back</button>
      <button class="dislike-cancel" type="button">Cancel</button>
      <button class="dislike-confirm primary" type="button">Apply</button>
    `;
    popoverBody.appendChild(footer);
  }

  function makeSeverityRow({ target, label, options, defaultValue }) {
    const el = document.createElement("div");
    el.className = "dislike-severity-row";
    const labelEl = document.createElement("div");
    labelEl.className = "dislike-severity-label";
    labelEl.textContent = label;
    el.appendChild(labelEl);

    const optsEl = document.createElement("div");
    optsEl.className = "dislike-severity-options";
    let value = defaultValue;
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dislike-severity-opt";
      btn.dataset.value = opt.value;
      btn.textContent = opt.label;
      if (opt.value === defaultValue) btn.classList.add("active");
      btn.addEventListener("click", () => {
        value = opt.value;
        optsEl.querySelectorAll(".dislike-severity-opt").forEach(b => {
          b.classList.toggle("active", b === btn);
        });
      });
      optsEl.appendChild(btn);
    }
    el.appendChild(optsEl);
    return {
      el,
      target,
      getValue: () => value
    };
  }

  // ---------- Apply changes ----------
  //
  // Builds the changes[] array, performs DB writes, logs to dislikeHistory,
  // then returns the dislike record's id (for undo wiring).

  async function applyDislike(fic, selection) {
    const changes = [];
    const reasons = [];

    // Severity rows live in selection.severity (Map of "kind:value" → row).
    // For the chip-only path (no severity step), there are no tag/author entries.

    const severityFor = (kind, value) => {
      const row = selection.severity.get(`${kind}:${value}`);
      return row ? row.getValue() : "less";
    };

    // Authors (single, but kept as Map for consistency).
    for (const authorOriginal of selection.author.values()) {
      const sev = severityFor("author", authorOriginal);
      if (sev === "never") {
        await setBlockedAuthor(authorOriginal);
        changes.push({ kind: "author_block", author: authorOriginal });
        reasons.push({ category: "author", value: authorOriginal, severity: "never" });
      } else if (sev === "less") {
        const { prior, next } = await bumpAuthorPenalty(authorOriginal, AUTHOR_DOWNWEIGHT);
        changes.push({ kind: "author_penalty", author: authorOriginal, prior, next });
        reasons.push({ category: "author", value: authorOriginal, severity: "less" });
      }
      // "from_author" is a tag-level severity, not author-level, so authors
      // don't have a from_author branch.
    }

    // Tags.
    for (const tagOriginal of selection.tags.values()) {
      const sev = severityFor("tag", tagOriginal);
      if (sev === "never") {
        // Remove from preferred (if present) and add to blocked.
        const prior = await getPreferredTagWeight(tagOriginal);
        if (prior != null) {
          await deletePreferredTag(tagOriginal);
        }
        await setBlockedTag(tagOriginal);
        changes.push({
          kind: "tag_block",
          value: tagOriginal,
          hadPreferred: prior != null,
          priorWeight: prior
        });
        reasons.push({ category: "tag", value: tagOriginal, severity: "never" });
      } else if (sev === "from_author") {
        const author = [...selection.author.values()][0];
        if (author) {
          await appendAuthorNegCombo(author, tagOriginal);
          changes.push({ kind: "author_neg_combo", author, value: tagOriginal });
          reasons.push({ category: "tag", value: tagOriginal, severity: "from_author", author });
        }
      } else {
        // "less" — downweight tag by TAG_DOWNWEIGHT.
        const prior = await getPreferredTagWeight(tagOriginal);
        const priorVal = prior == null ? 0 : prior;
        const next = priorVal + TAG_DOWNWEIGHT;
        await setPreferredTag(tagOriginal, next, false);
        changes.push({ kind: "tag_weight", value: tagOriginal, prior, next });
        reasons.push({ category: "tag", value: tagOriginal, severity: "less" });
      }
    }

    // Length / rating / not_feeling — logged only.
    if (selection.length) {
      reasons.push({
        category: "length",
        direction: selection.length.direction,
        wordCount: selection.length.wordCount
      });
      patternCounters[selection.length.direction] += 1;
    }
    if (selection.rating) {
      reasons.push({ category: "rating", value: selection.rating });
      patternCounters.ratings[selection.rating] = (patternCounters.ratings[selection.rating] || 0) + 1;
    }
    // notFeeling is intentionally NOT logged (per design — purely ephemeral).

    // Skip the dislikeHistory write entirely if the only thing the user picked
    // was "not feeling it" (no learning, nothing to undo, nothing to surface).
    const hasLearning = changes.length > 0 || reasons.length > 0;
    let id = null;
    if (hasLearning) {
      const record = {
        ficId: fic.ficId,
        title: fic.title || null,
        author: fic.author || null,
        timestamp: new Date().toISOString(),
        reasons,
        changes,
        canUndo: true
      };
      id = await addDislikeRecord(record);
    }

    return { id, changes, reasons };
  }

  // ---------- Undo ----------

  async function undoDislike(id, options = {}) {
    const record = await getDislikeRecord(id);
    if (!record) return { ok: false, reason: "not_found" };
    if (record.canUndo === false) return { ok: false, reason: "already_modified" };

    // Verify each change is still in the same state we recorded — if anything
    // has been further modified, refuse to undo. This is the "preferences
    // modified since" path.
    for (const c of record.changes) {
      const ok = await _changeStillReversible(c);
      if (!ok) {
        record.canUndo = false;
        await updateDislikeRecord(record);
        return { ok: false, reason: "modified" };
      }
    }

    // Reverse changes in reverse order so any ordering subtleties (rare) hold.
    for (const c of [...record.changes].reverse()) {
      await _reverseChange(c);
    }

    if (options.deleteRecord !== false) {
      await deleteDislikeRecord(id);
    } else {
      record.canUndo = false;
      await updateDislikeRecord(record);
    }
    return { ok: true };
  }

  async function _changeStillReversible(c) {
    switch (c.kind) {
      case "tag_weight": {
        // The tag should still have weight === next (otherwise something else
        // touched it).
        const cur = await getPreferredTagWeight(c.value);
        return cur === c.next;
      }
      case "tag_block": {
        const blockRec = await dbGet("preferences", `blocked_tag:${c.value}`);
        return !!blockRec;
      }
      case "author_penalty": {
        const a = await dbGet("authorAffinity", c.author);
        const cur = (a && typeof a.manualPenalty === "number") ? a.manualPenalty : 0;
        return cur === c.next;
      }
      case "author_block": {
        const blockRec = await dbGet("preferences", `blocked_author:${c.author}`);
        return !!blockRec;
      }
      case "author_neg_combo": {
        const a = await dbGet("authorAffinity", c.author);
        if (!a || !Array.isArray(a.negativeTagCombos)) return false;
        return a.negativeTagCombos.some(t => String(t).toLowerCase() === String(c.value).toLowerCase());
      }
    }
    return false;
  }

  async function _reverseChange(c) {
    switch (c.kind) {
      case "tag_weight": {
        if (c.prior == null) {
          // Tag wasn't in preferences before — remove the new entry entirely.
          await deletePreferredTag(c.value);
        } else {
          await setPreferredTag(c.value, c.prior, false);
        }
        return;
      }
      case "tag_block": {
        await deleteBlockedTag(c.value);
        if (c.hadPreferred && c.priorWeight != null) {
          await setPreferredTag(c.value, c.priorWeight, false);
        }
        return;
      }
      case "author_penalty": {
        await setAuthorPenalty(c.author, c.prior);
        return;
      }
      case "author_block": {
        await deleteBlockedAuthor(c.author);
        return;
      }
      case "author_neg_combo": {
        await removeAuthorNegCombo(c.author, c.value);
        return;
      }
    }
  }

  // ---------- Toast ----------

  function showUndoToast(dislikeId, message, onUndo) {
    if (currentToast) {
      currentToast.dismiss(false);
    }
    const toast = document.createElement("div");
    toast.className = "dislike-toast";
    toast.innerHTML = `
      <span class="dislike-toast-msg"></span>
      <button type="button" class="dislike-toast-undo">Undo</button>
    `;
    toast.querySelector(".dislike-toast-msg").textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));

    const dismiss = (animate = true) => {
      if (!currentToast || currentToast.toast !== toast) return;
      clearTimeout(currentToast.timer);
      currentToast = null;
      if (animate) {
        toast.classList.remove("visible");
        setTimeout(() => toast.remove(), 350);
      } else {
        toast.remove();
      }
    };

    const timer = setTimeout(dismiss, UNDO_WINDOW_MS);

    toast.querySelector(".dislike-toast-undo").addEventListener("click", async () => {
      const res = await undoDislike(dislikeId);
      if (res.ok) {
        if (typeof onUndo === "function") onUndo();
      } else if (res.reason === "modified") {
        // Shouldn't happen in the 10s window, but be defensive.
        console.warn("Could not undo (modified):", dislikeId);
      }
      dismiss();
    });

    currentToast = { toast, dismiss, timer };
  }

  // ---------- Pattern detection ----------

  async function maybeFirePatternPrompt() {
    const settings = (await getSettings()) || {};
    const dismissed = settings.dismissedPatternHints || {};

    // Length: too long.
    if (
      patternCounters.too_long >= PATTERN_THRESHOLD &&
      !patternShown.too_long &&
      !dismissed.length_too_long
    ) {
      patternShown.too_long = true;
      showPatternModal({
        kind: "length_too_long",
        title: "Lots of long fics flagged",
        body: "We've noticed you've flagged several long fics this session. Want to lower your max word count?",
        onApply: async () => {
          // Lower maxWords by ~25%, or set to 100k if not set.
          const recs = await getPreferencesByType("structural");
          const cur = recs[0] || { id: "structural", type: "structural", minWords: null, maxWords: null, ratings: [], completeOnly: false };
          const newMax = cur.maxWords ? Math.round(cur.maxWords * 0.75) : 100_000;
          await setStructuralPreferences({
            minWords: cur.minWords || null,
            maxWords: newMax,
            ratings: cur.ratings || [],
            completeOnly: cur.completeOnly || false
          });
          return `Set max words to ${newMax.toLocaleString()}.`;
        }
      });
      return;
    }

    // Length: too short.
    if (
      patternCounters.too_short >= PATTERN_THRESHOLD &&
      !patternShown.too_short &&
      !dismissed.length_too_short
    ) {
      patternShown.too_short = true;
      showPatternModal({
        kind: "length_too_short",
        title: "Lots of short fics flagged",
        body: "We've noticed you've flagged several short fics this session. Want to raise your minimum word count?",
        onApply: async () => {
          const recs = await getPreferencesByType("structural");
          const cur = recs[0] || { id: "structural", type: "structural", minWords: null, maxWords: null, ratings: [], completeOnly: false };
          const newMin = cur.minWords ? cur.minWords + 5_000 : 10_000;
          await setStructuralPreferences({
            minWords: newMin,
            maxWords: cur.maxWords || null,
            ratings: cur.ratings || [],
            completeOnly: cur.completeOnly || false
          });
          return `Set minimum words to ${newMin.toLocaleString()}.`;
        }
      });
      return;
    }

    // Ratings — first rating to cross threshold this session.
    for (const [rating, count] of Object.entries(patternCounters.ratings)) {
      if (
        count >= PATTERN_THRESHOLD &&
        !patternShown.ratings[rating] &&
        !((dismissed.ratings || {})[rating])
      ) {
        patternShown.ratings[rating] = true;
        showPatternModal({
          kind: `rating_${rating}`,
          title: `Lots of ${rating}-rated fics flagged`,
          body: `We've noticed you've flagged several ${rating}-rated fics. Want to remove ${rating} from your rating preferences?`,
          onApply: async () => {
            const recs = await getPreferencesByType("structural");
            const cur = recs[0];
            if (!cur) return "No structural preferences set.";
            const ratings = (cur.ratings || []).filter(r => r !== rating);
            await setStructuralPreferences({
              minWords: cur.minWords || null,
              maxWords: cur.maxWords || null,
              ratings,
              completeOnly: cur.completeOnly || false
            });
            return `Removed ${rating} from your rating preferences.`;
          },
          dismissKey: { kind: "rating", rating }
        });
        return;
      }
    }
  }

  function showPatternModal({ title, body, onApply, dismissKey, kind }) {
    // Simple modal — full-page backdrop, two buttons, one dismiss button.
    const backdrop = document.createElement("div");
    backdrop.className = "dislike-pattern-backdrop";
    backdrop.innerHTML = `
      <div class="dislike-pattern-modal" role="dialog" aria-modal="true">
        <h3 class="dislike-pattern-title"></h3>
        <p class="dislike-pattern-body"></p>
        <div class="dislike-pattern-actions">
          <button type="button" class="dislike-pattern-stop">Stop suggesting</button>
          <button type="button" class="dislike-pattern-not-now">Not now</button>
          <button type="button" class="dislike-pattern-apply primary">Update preferences</button>
        </div>
      </div>
    `;
    backdrop.querySelector(".dislike-pattern-title").textContent = title;
    backdrop.querySelector(".dislike-pattern-body").textContent = body;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();

    backdrop.querySelector(".dislike-pattern-not-now").addEventListener("click", close);

    backdrop.querySelector(".dislike-pattern-stop").addEventListener("click", async () => {
      const settings = (await getSettings()) || { id: "main" };
      settings.dismissedPatternHints = settings.dismissedPatternHints || {};
      if (kind === "length_too_long") settings.dismissedPatternHints.length_too_long = true;
      else if (kind === "length_too_short") settings.dismissedPatternHints.length_too_short = true;
      else if (dismissKey && dismissKey.kind === "rating") {
        settings.dismissedPatternHints.ratings = settings.dismissedPatternHints.ratings || {};
        settings.dismissedPatternHints.ratings[dismissKey.rating] = true;
      }
      await dbPut("settings", settings);
      close();
    });

    backdrop.querySelector(".dislike-pattern-apply").addEventListener("click", async () => {
      try {
        const msg = await onApply();
        close();
        if (typeof window.toast === "function") window.toast(msg || "Preferences updated.");
      } catch (e) {
        console.error("[dislike] pattern apply failed:", e);
        close();
      }
    });
  }

  // ---------- Public entry point ----------

  async function openDislikePopover(item, cardEl, opts = {}) {
    closeCurrentPopover();
    if (!item || !item.fic || !cardEl) return;

    // Phase 13 R2: capture the trigger element so we can return focus on close.
    const previouslyFocused = document.activeElement;

    const fic = item.fic;

    // Build the popover scaffolding.
    const popoverEl = buildPopoverShell();
    document.body.appendChild(popoverEl);
    const body = popoverEl.querySelector(".dislike-body");

    // Selection state shared between views.
    const selection = {
      author: new Map(),    // lowercase → original casing
      tags: new Map(),
      length: null,         // { direction, wordCount } | null
      rating: null,         // string | null
      notFeeling: false,
      severity: new Map()   // "kind:value" → severity row
    };

    // Build a set of preferred tag values (lowercased) for the "in your prefs" hint.
    const preferredTagRecs = await getPreferencesByType("preferred_tag");
    const preferredTagSet = new Set(
      preferredTagRecs
        .filter(r => typeof r.weight === "number" && r.weight > 0)
        .map(r => String(r.value).toLowerCase())
    );

    renderChipView(body, fic, selection, preferredTagSet);

    // Position once now (rough), then again after the next frame so we have
    // accurate measured size.
    positionPopover(popoverEl, cardEl);
    requestAnimationFrame(() => positionPopover(popoverEl, cardEl));

    // Wire close handlers.
    const outsideHandler = (e) => {
      if (!popoverEl.contains(e.target)) {
        closeCurrentPopover();
      }
    };
    const escHandler = (e) => {
      if (e.key === "Escape") {
        closeCurrentPopover();
        e.stopPropagation();
      }
    };
    const repositionHandler = () => positionPopover(popoverEl, cardEl);

    // Defer attaching the outside-click handler until after this click cycle
    // finishes — otherwise the same click that opened the popover would close it.
    setTimeout(() => {
      document.addEventListener("click", outsideHandler, true);
    }, 0);
    document.addEventListener("keydown", escHandler);
    window.addEventListener("scroll", repositionHandler, true);
    window.addEventListener("resize", repositionHandler);

    currentPopover = {
      el: popoverEl,
      outsideHandler,
      escHandler,
      repositionHandler,
      previouslyFocused
    };

    // Move focus into the dialog so screen readers announce it and keyboard
    // users can immediately Tab through the chips. The popover root has
    // tabIndex=-1 (set in buildPopoverShell) for programmatic focus.
    requestAnimationFrame(() => popoverEl.focus());

    // Wire button delegate inside popover.
    popoverEl.addEventListener("click", async (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      if (target.closest(".dislike-close")) {
        closeCurrentPopover();
        return;
      }
      if (target.closest(".dislike-cancel")) {
        closeCurrentPopover();
        return;
      }
      if (target.closest(".dislike-back")) {
        // Re-render chip view but keep the existing selection so chips stay active.
        renderChipView(body, fic, selection, preferredTagSet);
        // Rehydrate the chip "active" classes from selection state.
        rehydrateChipState(body, selection);
        positionPopover(popoverEl, cardEl);
        return;
      }
      if (target.closest(".dislike-continue")) {
        // If the user picked at least one tag or author, show severity view.
        if (selection.author.size > 0 || selection.tags.size > 0) {
          renderSeverityView(body, fic, selection);
          positionPopover(popoverEl, cardEl);
          return;
        }
        // Otherwise (length / rating / not-feeling only): apply immediately.
        await applyAndClose();
        return;
      }
      if (target.closest(".dislike-confirm")) {
        await applyAndClose();
        return;
      }
    });

    async function applyAndClose() {
      // Hide card immediately for responsiveness.
      const onApplied = opts.onApplied;
      const onUndone = opts.onUndone;

      // Remember card location so a successful undo can restore it later.
      cardEl.classList.add("dislike-hidden");

      const { id, changes, reasons } = await applyDislike(fic, selection);
      closeCurrentPopover();

      // Update fic-page lock list (not relevant here — feed-only). Just check
      // whether anything was actually applied.
      const hasLearning = changes.length > 0 || reasons.length > 0;

      if (hasLearning && id != null) {
        const summary = summarizeReasons(reasons);
        showUndoToast(id, `Hid this fic. ${summary}`, () => {
          // Undo restores the card visually.
          cardEl.classList.remove("dislike-hidden");
          if (typeof onUndone === "function") onUndone();
        });
        if (typeof onApplied === "function") onApplied({ id, changes, reasons });
        // Pattern detection runs after every applied dislike.
        maybeFirePatternPrompt().catch(e => console.warn("pattern prompt failed:", e));
      } else if (selection.notFeeling) {
        // Pure session hide. No undo (nothing to undo) — just confirm visually.
        if (typeof window.toast === "function") {
          window.toast("Hid this fic for now.");
        }
        if (typeof onApplied === "function") onApplied({ id: null, changes: [], reasons: [] });
      }
    }
  }

  function rehydrateChipState(body, selection) {
    body.querySelectorAll(".dislike-chip").forEach(chip => {
      const kind = chip.dataset.kind;
      const value = chip.dataset.value;
      if (kind === "author" && selection.author.has(String(value).toLowerCase())) {
        chip.classList.add("active");
      } else if (kind === "tag" && selection.tags.has(String(value).toLowerCase())) {
        chip.classList.add("active");
      } else if (kind === "rating" && selection.rating === value) {
        chip.classList.add("active");
      } else if (kind === "not_feeling" && selection.notFeeling) {
        chip.classList.add("active");
      }
    });
  }

  function summarizeReasons(reasons) {
    const counts = { tag: 0, author: 0, length: 0, rating: 0 };
    for (const r of reasons) counts[r.category] = (counts[r.category] || 0) + 1;
    const parts = [];
    if (counts.tag) parts.push(`${counts.tag} tag${counts.tag === 1 ? "" : "s"}`);
    if (counts.author) parts.push("author");
    if (counts.length) parts.push("length");
    if (counts.rating) parts.push("rating");
    if (parts.length === 0) return "";
    return `Updated: ${parts.join(", ")}.`;
  }

  // ---------- Plain-language formatters for history view ----------

  function formatDislikeReason(reason) {
    switch (reason.category) {
      case "author":
        return reason.severity === "never"
          ? `Blocked author "${reason.value}"`
          : `Less of author "${reason.value}"`;
      case "tag":
        if (reason.severity === "never") return `Blocked tag "${reason.value}"`;
        if (reason.severity === "from_author") return `Tag "${reason.value}" only from "${reason.author}"`;
        return `Less of tag "${reason.value}"`;
      case "length":
        return reason.direction === "too_long"
          ? `Length: too long (${(reason.wordCount || 0).toLocaleString()} words)`
          : `Length: too short (${(reason.wordCount || 0).toLocaleString()} words)`;
      case "rating":
        return `Rating: ${reason.value}`;
      default:
        return JSON.stringify(reason);
    }
  }

  function formatDislikeChange(change) {
    switch (change.kind) {
      case "tag_weight":
        return `"${change.value}" weight ${change.prior == null ? "(new)" : change.prior} → ${change.next}`;
      case "tag_block":
        return `"${change.value}" added to blocked tags${change.hadPreferred ? ` (was preferred at ${change.priorWeight})` : ""}`;
      case "author_penalty":
        return `Author "${change.author}" penalty ${change.prior} → ${change.next}`;
      case "author_block":
        return `Author "${change.author}" added to blocked authors`;
      case "author_neg_combo":
        return `Tag "${change.value}" pinned negatively to author "${change.author}"`;
      default:
        return JSON.stringify(change);
    }
  }

  // ---------- Exports ----------

  window.openDislikePopover = openDislikePopover;
  window.undoDislikeFromHistory = (id) => undoDislike(id);
  window.formatDislikeReason = formatDislikeReason;
  window.formatDislikeChange = formatDislikeChange;

})();
