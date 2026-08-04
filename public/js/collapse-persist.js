'use strict';
// Remembers open/closed state for <details class="card" data-key="..."> sections,
// per full URL (path + query string), across visits. data-key only needs to be
// unique within a page — keying by the full URL means competition-detail.html?id=17
// and ?id=21 get independent state, matching that competitions (and phases,
// tournaments, etc.) are independent entities with independent amounts of content,
// not one shared "I always collapse Rounds" habit. Costs nothing on pages with no
// query string (admin.html, ...) — their URL never varies, so this degrades to the
// same per-page behavior there.
//
// A MutationObserver (not just a one-shot querySelectorAll on load) is required
// because several pages only render their cards inside an Alpine `x-if`/`x-for`
// once async data has loaded — those <details> elements don't exist in the DOM
// yet when this script's initial pass runs. No Alpine dependency either way —
// <details> collapse is already native.
(function () {
  const prefix = 'atlas-collapse:' + location.pathname + location.search + ':';
  const applied = new WeakSet();

  function apply(el) {
    if (applied.has(el)) return;
    applied.add(el);

    const storageKey = prefix + el.dataset.key;
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) el.open = stored === '1';

    el.addEventListener('toggle', () => {
      localStorage.setItem(storageKey, el.open ? '1' : '0');
    });
  }

  function scan(root) {
    if (root.matches?.('details.card[data-key]')) apply(root);
    root.querySelectorAll?.('details.card[data-key]').forEach(apply);
  }

  scan(document.body);

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
