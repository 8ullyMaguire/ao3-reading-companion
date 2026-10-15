// lorehaven-page.js — the instance feed: what the instance recommends, in the instance's
// order, with the reasons it recorded.
//
// This page does no ranking of any kind (§48.2). It asks, it renders, and where it does not
// know something it says so — an invented reason or a locally re-sorted list would be the
// exact failure this port exists to remove.
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function show(state) {
    for (const id of ['state-setup', 'state-loading', 'state-error', 'feed-main']) {
      const node = $(id);
      if (node) node.hidden = id !== state;
    }
  }

  function count(n, word) {
    return typeof n === 'number' ? `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}` : null;
  }

  // The reason block. THREE outcomes, never two: recorded reasons, a recorded slot with no
  // reader-side reasons, or a slot we could not read. The third is stated as an absence.
  function whyBlock(reason) {
    if (!reason.available) {
      return `<p class="why unavailable"><strong>Why this?</strong> Not available — the recorded
        slot could not be read. Nothing is guessed in its place.</p>`;
    }
    const bits = [];
    if (reason.blendScore !== null) bits.push(`blend score ${reason.blendScore}`);
    if (reason.servedAt) bits.push(`served ${esc(reason.servedAt)}`);
    const list = reason.lines.length
      ? `<ul>${reason.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
      : `<p class="muted">The server recorded this slot without reader-side reasons.</p>`;
    return `<details class="why"><summary>Why this?</summary>${list}
      ${bits.length ? `<p class="tiny">${esc(bits.join(' · '))}</p>` : ''}
      ${reason.seededBy ? `<p class="tiny">seeded by ${esc(reason.seededBy)}</p>` : ''}
      </details>`;
  }

  function card(item, instance) {
    const f = item.fic;
    if (!f) {
      return `<article class="card">
        <h3 class="title muted">Details unavailable</h3>
        <p class="muted">The server recommended a work whose details this extension could not
        read. It keeps its place in the list — the ranking is the server's.</p>
        <p class="tiny">work ${esc(item.workId)}</p>
      </article>`;
    }
    const facts = [
      f.author ? esc(f.author) + (f.coauthors && f.coauthors.length ? ` +${f.coauthors.length}` : '') : null,
      f.rating ? esc(f.rating) : null,
      f.isComplete ? 'complete' : null,
      count(f.wordCount, 'word'),
      f.chapters ? `${f.chapters} chapter${f.chapters === 1 ? '' : 's'}` : null,
      count(f.kudos, 'kudos'),
      count(f.hits, 'view'),
      count(f.bookmarks, 'bookmark'),
    ].filter(Boolean);
    return `<article class="card">
      <h3 class="title">${esc(f.title || '(untitled)')}${item.read ? ' <span class="badge">read</span>' : ''}</h3>
      <p class="facts">${facts.join(' · ')}</p>
      ${f.summary ? `<p class="summary">${esc(f.summary)}</p>` : ''}
      ${f.recBlurb ? `<blockquote class="blurb">${esc(f.recBlurb.excerpt || f.recBlurb.text || '')}
        ${f.recBlurb.pseud_handle ? `<cite>— ${esc(f.recBlurb.pseud_handle)}</cite>` : ''}
        ${f.recBlurb.truncated ? '<span class="tiny"> (excerpt)</span>' : ''}</blockquote>` : ''}
      ${whyBlock(item.reason)}
      <p class="tiny">
        <a href="${esc(instance)}/api/v1/works/${esc(f.ficId)}" target="_blank" rel="noopener">this work on the instance</a>
        ${item.slotId ? ` · slot ${esc(item.slotId)}` : ''}
      </p>
    </article>`;
  }

  function setupForm(instance) {
    return `<form id="instance-form" class="setup">
      <label for="instance-url">Lorehaven instance</label>
      <input id="instance-url" type="url" required placeholder="https://lorehaven.example"
             value="${esc(instance)}" autocomplete="off" spellcheck="false">
      <button type="submit" class="primary">Use this instance</button>
      <p class="tiny">Requests go to this origin or they do not go (§48.5).</p>
    </form>`;
  }

  async function load() {
    let instance = '';
    try { instance = (await getInstance()) || ''; } catch (e) { console.error(e); }

    $('instance-line').textContent = instance || 'no instance configured';
    if (!instance) {
      $('state-setup').innerHTML = setupForm('');
      $('instance-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const value = $('instance-url').value.trim();
        if (!value) return;
        await setInstance(value);
        load();
      });
      show('state-setup');
      return;
    }

    setBaseUrl(instance);
    show('state-loading');

    try {
      // §48.5: a failed reload serves the previous copy, labelled with the time it was fetched.
      const feed = await cached('lh:feed', () => getFeed());
      const discovery = feed.data;

      const worksById = {};
      const explanationsById = {};
      for (const it of (discovery.items || [])) {
        const wid = String(it.work_id);
        try { worksById[wid] = (await cached('lh:work:' + wid, () => getWork(wid))).data; }
        catch (e) { worksById[wid] = null; }   // the card states the absence; the order stands
        if (it.slot_id) {
          try { explanationsById[it.slot_id] = (await cached('lh:slot:' + it.slot_id, () => explainSlot(it.slot_id))).data; }
          catch (e) { explanationsById[it.slot_id] = null; }
        }
      }

      let history = [];
      try { history = (await cached('lh:history', () => getHistory())).data; } catch (e) { history = []; }

      const model = buildFeed({ discovery, worksById, history, explanationsById });

      const label = staleLabel(feed);
      $('feed-meta').textContent = [
        model.sort ? `sort: ${model.sort}` : null,
        `${model.items.length} recommendation${model.items.length === 1 ? '' : 's'}`,
        label,
      ].filter(Boolean).join(' · ');
      $('feed-meta').classList.toggle('stale', !!label);
      $('cards').innerHTML = model.items.map((item) => card(item, instance)).join('') ||
        '<p class="muted">The instance returned no recommendations.</p>';
      show('feed-main');
    } catch (err) {
      $('error-text').textContent = err && err.message ? err.message : String(err);
      show('state-error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const refresh = $('refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      const instance = (await getInstance()) || '';
      if (!instance) return;
      setBaseUrl(instance);
      // A refresh asks for fresh data; the cache is age-bounded by itself, so drop our keys.
      try { await browser.storage.local.remove(['lh:feed']); } catch (e) { /* no storage: fine */ }
      load();
    });
    load();
  });
})();
