"use strict";
(() => {
  // src/shared/extract.ts
  var MONEY_LINE = /^([-−–+]?)\s*US?\$\s?([\d,]+(?:\.\d{1,2})?)$/;
  var MONEY_TRAILING = /\s([-−–+]?\s*US?\$\s?[\d,]+(?:\.\d{1,2})?)$/;
  var QTY = /^(\d+)\s*[×x](?:\s+(.*))?$/i;
  var DISPUTE_CHIP = /^Dispute (approved|denied|rejected|declined|pending|in review|submitted|eligible|available)$/i;
  var REASON = /^(missing|incorrect|wrong|late|never|not delivered|damaged|spilled|quality|cold|order )/i;
  var TIME = /^\d{1,2}:\d{2}\s*[ap]m$/i;
  var QUOTED = /^\(Quoted:\s*(.+)\)$/i;
  var PROFILE_NOISE = /years? on DoorDash|orders? from your store|^new to DoorDash$/i;
  var UI_NOISE = /^(top customer|learn more about top customers|report|rate dasher)$/i;
  var MONTHS = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };
  function parseMoney(s) {
    const m = s.trim().match(MONEY_LINE);
    if (!m) return null;
    const v = parseFloat(m[2].replace(/,/g, ""));
    return m[1] === "-" || m[1] === "\u2212" || m[1] === "\u2013" ? -v : v;
  }
  function isMoneyLine(l) {
    return MONEY_LINE.test(l.trim());
  }
  function valueAfter(lines, i, window2 = 2) {
    const trailing = lines[i].match(MONEY_TRAILING);
    if (trailing) return parseMoney(trailing[1].replace(/\s+/g, ""));
    for (let j = i + 1; j <= i + window2 && j < lines.length; j++) {
      if (isMoneyLine(lines[j])) return parseMoney(lines[j]);
    }
    return null;
  }
  function parsePlacedAt(text) {
    const m = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!m) return null;
    const month = MONTHS[m[2].toLowerCase()];
    if (month === void 0) return null;
    let hour = parseInt(m[4], 10) % 12;
    if (m[6].toLowerCase() === "pm") hour += 12;
    const pad = (n) => String(n).padStart(2, "0");
    return `${m[3]}-${pad(month + 1)}-${pad(parseInt(m[1], 10))}T${pad(hour)}:${m[5]}`;
  }
  function splitEntries(block) {
    const out = [];
    let cur = null;
    for (const l of block) {
      const m = l.match(QTY);
      if (m) {
        cur = { qty: parseInt(m[1], 10), rest: m[2] ? [m[2]] : [] };
        out.push(cur);
      } else if (cur) {
        cur.rest.push(l);
      }
    }
    return out;
  }
  function parseItem(e) {
    let name = "";
    let price = null;
    const options = [];
    for (const l of e.rest) {
      if (isMoneyLine(l)) {
        if (price === null) price = parseMoney(l);
      } else if (!name) {
        name = l;
      } else {
        options.push(l);
      }
    }
    return { qty: e.qty, name, options, price };
  }
  function parseErrorEntry(e, names) {
    const out = {
      item: "",
      options: [],
      reason: null,
      disputeStatus: null,
      amount: null,
      customerComment: null
    };
    let expectComment = false;
    for (const l of e.rest) {
      const commenter = l.match(/^(.+) left a comment$/);
      if (isMoneyLine(l)) {
        if (out.amount === null) out.amount = parseMoney(l);
      } else if (commenter) {
        names.push(commenter[1]);
        expectComment = true;
      } else if (expectComment) {
        out.customerComment = l.replace(/^["“”']+|["“”']+$/g, "");
        expectComment = false;
      } else if (DISPUTE_CHIP.test(l)) {
        out.disputeStatus = l.replace(/^Dispute /i, "").toLowerCase();
      } else if (out.reason === null && REASON.test(l) && l.length < 60) {
        out.reason = l;
      } else if (!out.item) {
        out.item = l;
      } else {
        out.options.push(l);
      }
    }
    return out;
  }
  function parseOrder(rawText) {
    const lines = rawText.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const find = (pred, from = 0, to = lines.length) => {
      for (let i = Math.max(from, 0); i < to; i++) if (pred(lines[i])) return i;
      return -1;
    };
    const names = [];
    const iOrder = find((l) => /^Order:\s*\S+/.test(l));
    const orderId = iOrder >= 0 ? lines[iOrder].replace(/^Order:\s*/, "").trim() : "";
    const iPlaced = find((l) => /^Order placed:/i.test(l));
    const placedAtText = iPlaced >= 0 ? lines[iPlaced].replace(/^Order placed:\s*/i, "") : null;
    const iDelivery = find((l) => l === "Delivery details");
    const iDetails = find((l) => l === "Order details");
    const iErr = find((l) => l === "Error charges", Math.max(iDetails, 0));
    const iErrSub = find((l) => l === "Error charge subtotal", Math.max(iErr, 0));
    const iAssoc = find((l) => /^Associated transactions/i.test(l));
    const headerEnd = iDelivery >= 0 ? iDelivery : iDetails >= 0 ? iDetails : lines.length;
    const header = lines.slice(Math.max(iOrder, 0) + 1, headerEnd);
    const status = header.find((l) => /^(Completed|Cancelled|Canceled|Refunded|In progress|Active|Scheduled)$/i.test(l)) ?? null;
    const disputeChip = header.find((l) => DISPUTE_CHIP.test(l));
    const disputeStatus = disputeChip ? disputeChip.replace(/^Dispute /i, "").toLowerCase() : null;
    const notice = header.find((l) => l.length > 30 && /dispute/i.test(l)) ?? null;
    const dEnd = iDetails >= 0 ? iDetails : lines.length;
    const iCustomer = find((l) => l === "Customer", iDelivery, dEnd);
    const iDasher = find((l) => l === "Dasher", iDelivery, dEnd);
    const iPicked = find((l) => l === "Picked up", iDelivery, dEnd);
    const nameAfter = (from, to) => {
      for (let i = from + 1; i < to; i++) {
        const l = lines[i];
        if (l.length <= 1 || UI_NOISE.test(l) || PROFILE_NOISE.test(l)) continue;
        return l;
      }
      return null;
    };
    if (iCustomer >= 0) {
      const n = nameAfter(iCustomer, iDasher > iCustomer ? iDasher : iPicked > iCustomer ? iPicked : dEnd);
      if (n) names.push(n);
    }
    if (iDasher >= 0) {
      const n = nameAfter(iDasher, iPicked > iDasher ? iPicked : dEnd);
      if (n) names.push(n);
    }
    const pairs = [];
    for (let i = Math.max(iPicked, iDelivery, 0); i < dEnd; i++) {
      if (!TIME.test(lines[i])) continue;
      const q = lines[i + 1]?.match(QUOTED);
      pairs.push({ actual: lines[i], quoted: q ? q[1] : null });
    }
    const none = { actual: null, quoted: null };
    const channelLine = lines.slice(Math.max(iDelivery, 0), dEnd).find((l) => /^(Marketplace|Storefront|Drive)$/i.test(l)) ?? null;
    const fulfillLine = lines.slice(Math.max(iDelivery, 0), dEnd).find((l) => /^(DoorDash delivery|Self[- ]delivery|Pickup|Dine[- ]in)$/i.test(l)) ?? null;
    const odEnd = iErr >= 0 ? iErr : iAssoc >= 0 ? iAssoc : lines.length;
    const iSubtotal = find((l) => l === "Subtotal", iDetails, odEnd);
    const itemBlock = iDetails >= 0 ? lines.slice(iDetails + 1, iSubtotal >= 0 ? iSubtotal : odEnd) : [];
    const items = splitEntries(itemBlock).map(parseItem);
    const rowValue = (label, from, to) => {
      const i = find((l) => typeof label === "string" ? l === label : label.test(l), from, to);
      return i >= 0 ? valueAfter(lines, i) : null;
    };
    const iCommission = find((l) => /^Commission/i.test(l), iDetails, odEnd);
    const commissionPct = iCommission >= 0 ? parseFloat(lines[iCommission].match(/\(([\d.]+)%\)/)?.[1] ?? "NaN") : NaN;
    const errBlock = iErr >= 0 ? lines.slice(iErr + 1, iErrSub >= 0 ? iErrSub : iAssoc >= 0 ? iAssoc : lines.length) : [];
    const errorCharges = splitEntries(errBlock).map((e) => parseErrorEntry(e, names));
    const tailFrom = iErrSub >= 0 ? iErrSub : iErr >= 0 ? iErr : 0;
    const transactions = [];
    if (iAssoc >= 0) {
      for (let i = iAssoc + 1; i < lines.length; i++) {
        const m = lines[i].match(/^Transaction #(\d+)\s*[-–]\s*(.+?)(?:\s+([-−–+]?\s*US?\$\s?[\d,]+(?:\.\d{1,2})?))?$/);
        if (!m) continue;
        const amount = m[3] ? parseMoney(m[3].replace(/\s+/g, "")) : valueAfter(lines, i);
        transactions.push({ id: m[1], kind: m[2], amount });
      }
    }
    const snapshot = {
      orderId,
      placedAtText,
      placedAt: placedAtText ? parsePlacedAt(placedAtText) : null,
      status,
      disputeStatus,
      notice,
      channel: channelLine,
      fulfillment: fulfillLine,
      pickedUp: pairs[0] ?? { ...none },
      droppedOff: pairs[1] ?? { ...none },
      items,
      subtotal: rowValue("Subtotal", iDetails, odEnd),
      tax: rowValue("Tax", iDetails, odEnd),
      commissionPct: Number.isNaN(commissionPct) ? null : commissionPct,
      commission: iCommission >= 0 ? valueAfter(lines, iCommission) : null,
      orderTotal: rowValue("Order total", iDetails, odEnd),
      errorCharges,
      errorChargeTotal: rowValue("Error charge total", tailFrom, lines.length),
      errorCredit: rowValue(/^Error charge credit/i, tailFrom, lines.length),
      estimatedPayout: rowValue("Estimated payout", tailFrom, lines.length),
      transactions
    };
    return { snapshot, names: [...new Set(names.filter((n) => n.length >= 2))] };
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function redactText(text, names) {
    let out = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).filter((l) => l.length > 1 && !UI_NOISE.test(l) && !PROFILE_NOISE.test(l)).join("\n");
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(escapeRegExp(n), "g"), "[PERSON]");
    }
    return out;
  }

  // src/content/dom.ts
  var ORDER_HEADING = /(^|\n)Order:\s*[A-Z0-9]{4,}/;
  var PROFILE_TEXT = /years? on DoorDash|orders? from your store|^\s*Top customer\s*$|Learn more about top customers/i;
  function findOrderRoot() {
    const candidates = document.querySelectorAll(
      '[class*="SidesheetBody"], [class*="SidesheetContent"], [role="dialog"], [aria-modal="true"]'
    );
    for (const el of candidates) {
      if (ORDER_HEADING.test(el.innerText)) return el;
    }
    return ORDER_HEADING.test(document.body.innerText) ? document.body : null;
  }
  function viewport() {
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  }
  function toRect(r, pad = 4) {
    return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
  }
  function visible(r, vp) {
    return r.w > 0 && r.h > 0 && r.x < vp.innerWidth && r.y < vp.innerHeight && r.x + r.w > 0 && r.y + r.h > 0;
  }
  function computeRects(root, names) {
    if (names.length === 0) return null;
    const vp = viewport();
    const rects = [];
    const found = /* @__PURE__ */ new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const hitName = names.find((n) => text.includes(n));
      if (!hitName && !PROFILE_TEXT.test(text)) continue;
      if (hitName) found.add(hitName);
      const start2 = node.parentElement;
      if (!start2) continue;
      let target = start2;
      for (let i = 0; i < 2; i++) {
        const parent = target.parentElement;
        if (!parent || parent === root) break;
        const pr = parent.getBoundingClientRect();
        if (pr.height > 80 || pr.width > root.getBoundingClientRect().width * 0.98) break;
        target = parent;
      }
      rects.push(toRect(target.getBoundingClientRect()));
    }
    if (names.some((n) => !found.has(n))) return null;
    return rects.filter((r) => visible(r, vp));
  }
  function scrolls(el, minHeight) {
    return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.clientHeight >= minHeight && el.scrollHeight > el.clientHeight + 4;
  }
  function findScroller(root) {
    for (let el = root; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (scrolls(el, 1)) return el;
    }
    let best = null;
    for (const el of root.querySelectorAll("*")) {
      if (scrolls(el, 200) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
    }
    return best ?? document.documentElement;
  }
  var isPage = (el) => el === document.documentElement || el === document.body;
  function scrollMetrics(el) {
    if (isPage(el)) {
      const vp = viewport();
      return {
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: vp.innerHeight,
        region: { x: 0, y: 0, w: vp.innerWidth, h: vp.innerHeight }
      };
    }
    const r = el.getBoundingClientRect();
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, region: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }
  function setScrollTop(el, top) {
    if (isPage(el)) window.scrollTo({ top, behavior: "instant" });
    else el.scrollTo({ top, behavior: "instant" });
  }

  // src/content/index.ts
  function buildPayload() {
    const root = findOrderRoot();
    if (!root) return null;
    const text = root.innerText;
    const { snapshot, names } = parseOrder(text);
    if (!snapshot.orderId) return null;
    return {
      names,
      payload: {
        url: location.href,
        snapshot,
        redactedText: redactText(text, names),
        rects: computeRects(root, names),
        viewport: viewport()
      }
    };
  }
  function signature(p) {
    let h = 0;
    for (let i = 0; i < p.redactedText.length; i++) h = h * 31 + p.redactedText.charCodeAt(i) | 0;
    return `${p.snapshot.orderId}:${h}`;
  }
  var lastSent = "";
  var timer;
  function check() {
    const built = buildPayload();
    if (!built) {
      lastSent = "";
      return;
    }
    const sig = signature(built.payload);
    if (sig === lastSent) return;
    lastSent = sig;
    const msg = { type: "ORDER_DETECTED", payload: built.payload };
    chrome.runtime.sendMessage(msg).catch(() => {
    });
  }
  async function frame(top) {
    const root = findOrderRoot();
    if (!root) return null;
    const scroller = findScroller(root);
    if (top !== null) {
      setScrollTop(scroller, top);
      await new Promise((r) => setTimeout(r, 350));
    }
    const { names } = parseOrder(root.innerText);
    return { ...scrollMetrics(scroller), rects: computeRects(root, names), viewport: viewport() };
  }
  function start() {
    new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 900);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    check();
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "GET_PAYLOAD") {
        sendResponse(buildPayload()?.payload ?? null);
      } else if (msg.type === "SCROLL_FRAME") {
        void frame(msg.top).then(sendResponse, () => sendResponse(null));
        return true;
      }
      return false;
    });
  }
  var flag = window;
  if (!flag.__korefiReader) {
    flag.__korefiReader = true;
    start();
  }
})();
