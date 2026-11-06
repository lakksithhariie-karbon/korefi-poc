/* Normalize duplicate captures without losing an operator's workflow state. */
(() => {
  let normalizing = false;
  let debounce;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.cases || normalizing) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (normalizing) return;
      normalizing = true;
      try {
        const { cases = [] } = await chrome.storage.local.get('cases');
        const map = new Map(), out = [];
        for (const c of cases) {
          // Include placedAt because some outlets can reuse short order references.
          const key = `${c.orderId}|${c.snapshot?.placedAt || ''}`;
          const prev = map.get(key);
          if (!prev) {map.set(key,c);out.push(c);continue;}
          const newest = new Date(c.createdAt) > new Date(prev.createdAt) ? c : prev;
          const oldest = newest===c?prev:c;
          // Prefer a case with existing operations, then preserve status/audit and AI assessment.
          const state = [prev,c].find(x => x.ops?.audit?.length || ['filed','won','lost','skipped'].includes(x.status)) || oldest;
          const combined = {...oldest,...newest,id:oldest.id,createdAt:oldest.createdAt,
            image:newest.image||oldest.image,assessment:newest.assessment||oldest.assessment,
            status:state.status,ops:state.ops};
          map.set(key,combined);
          out[out.indexOf(prev)] = combined;
        }
        if (out.length !== cases.length) await chrome.storage.local.set({cases:out});
      } catch(e) {console.warn('KoreFi ops deduplication failed',e);}
      finally {normalizing=false;}
    },150);
  });
})();
