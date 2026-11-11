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
  function parseErrorEntry(e) {
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
    const errorCharges = splitEntries(errBlock).map((e) => parseErrorEntry(e));
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
      platform: "doordash",
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
    return { snapshot };
  }

  // src/shared/extract-ubereats.ts
  var MONEY = /^([-−–+]?)\s*(?:US|CA|A)?\$\s?([\d,]+(?:\.\d{1,2})?)$/;
  var ORDER = /^Order\s+([A-Z0-9]{4,16})$/;
  var DATE = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/;
  var TIME24 = /^\d{1,2}:\d{2}$/;
  var QTY2 = /^\d{1,3}$/;
  var OPTION_HEADER = /^\((?:OPTIONAL|REQUIRED|MANDATORY)\)/i;
  var FLAG = /(customi[sz]ation (?:reported )?wrong|wrong item|item missing|missing item|missing|incorrect|wrong)/i;
  var STATUS = /^Dispute (approved|denied|rejected|declined|pending|in review|submitted)$/i;
  var MONTHS2 = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    sept: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };
  function parseMoneyAny(s) {
    const m = s.trim().match(MONEY);
    if (!m) return null;
    const v = parseFloat(m[2].replace(/,/g, ""));
    return m[1] && m[1] !== "+" ? -v : v;
  }
  var isMoney = (l) => MONEY.test(l.trim());
  function uberPlacedAt(date, time) {
    const m = date?.match(DATE);
    if (!m) return null;
    const month = MONTHS2[m[2].slice(0, 4).toLowerCase()] ?? MONTHS2[m[2].slice(0, 3).toLowerCase()];
    if (month === void 0) return null;
    const pad = (n) => String(n).padStart(2, "0");
    const [h, min] = (time ?? "00:00").split(":").map((x) => parseInt(x, 10));
    return `${m[3]}-${pad(month + 1)}-${pad(parseInt(m[1], 10))}T${pad(h)}:${pad(min)}`;
  }
  function parseUberOrder(rawText) {
    const lines = rawText.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const find = (pred, from = 0, to = lines.length) => {
      for (let i2 = Math.max(from, 0); i2 < to; i2++) if (pred(lines[i2])) return i2;
      return -1;
    };
    const iOrder = find((l) => ORDER.test(l));
    const orderId = iOrder >= 0 ? lines[iOrder].match(ORDER)[1] : "";
    const iDelivery = find((l) => l === "Delivery details");
    const iDetails = find((l) => l === "Order details");
    const headEnd = iDelivery >= 0 ? iDelivery : iDetails >= 0 ? iDetails : lines.length;
    const head = lines.slice(iOrder + 1, headEnd);
    const dateLine = head.find((l) => DATE.test(l)) ?? null;
    const shop = head.find((l) => l !== dateLine && /\(.+\)|avenue|street|road|blvd|ave\b|st\b/i.test(l) && !/deducted|reported|dispute/i.test(l)) ?? null;
    const bannerStart = head.findIndex((l) => l !== dateLine && l !== shop && !DATE.test(l));
    const banner = bannerStart >= 0 ? head.slice(bannerStart).filter((l) => l !== "Dispute" && l !== shop) : [];
    const deducted = banner.map((l) => l.match(/\$([\d,]+(?:\.\d{1,2})?)\s+deducted/i)).find(Boolean);
    const issueHeadline = banner.find((l) => FLAG.test(l) && l.length < 60) ?? null;
    const disputeOffered = head.includes("Dispute");
    const statusLine = lines.find((l) => STATUS.test(l));
    const timeline = [];
    let i = iDetails >= 0 ? iDetails + 1 : lines.length;
    while (i + 1 < lines.length && TIME24.test(lines[i]) && !TIME24.test(lines[i + 1])) {
      timeline.push({ time: lines[i], event: lines[i + 1] });
      i += 2;
    }
    const iMoney = find((l) => /^Sales\b/i.test(l), i);
    const end = iMoney >= 0 ? iMoney : lines.length;
    const items = [];
    let item = null;
    let header = null;
    let lastOption = null;
    for (let j = i; j < end; j++) {
      const l = lines[j];
      if (OPTION_HEADER.test(l)) {
        header = l;
        continue;
      }
      if (/^Customer feedback$/i.test(l)) {
        const said = [];
        for (j = j + 1; j < end && !/^View (less|more)$/i.test(lines[j]) && !OPTION_HEADER.test(lines[j]) && !QTY2.test(lines[j]); j++) said.push(lines[j]);
        if (/^View (less|more)$/i.test(lines[j] ?? "")) j++;
        j--;
        if (item) item.feedback = said.join(" ").trim() || null;
        continue;
      }
      if (/^View (less|more)$/i.test(l)) continue;
      if (QTY2.test(l) && j + 1 < end) {
        const name = lines[j + 1];
        if (header && item) {
          lastOption = `${header.replace(OPTION_HEADER, "").trim()}: ${name}`;
          item.options.push(lastOption);
          header = null;
        } else {
          item = { qty: parseInt(l, 10), name, options: [], price: null, flags: [], flaggedOptions: [], feedback: null };
          items.push(item);
          lastOption = null;
        }
        j++;
        continue;
      }
      if (!item) continue;
      if (isMoney(l)) {
        if (item.price === null && !lastOption) item.price = parseMoneyAny(l);
        continue;
      }
      if (FLAG.test(l) && l.length < 60) {
        if (lastOption) item.flaggedOptions.push(`${lastOption} (${l})`);
        else item.flags.push(l);
        continue;
      }
      if (j + 1 < end && QTY2.test(lines[j + 1])) header = l;
    }
    const value = (label) => {
      const k = find((l) => label.test(l), end);
      if (k < 0) return null;
      const same = lines[k].match(/((?:[-−–+]\s*)?(?:US|CA|A)?\$\s?[\d,]+(?:\.\d{1,2})?)$/);
      if (same && lines[k] !== same[1]) return parseMoneyAny(same[1].replace(/\s+/g, ""));
      for (let n = k + 1; n <= k + 3 && n < lines.length; n++) if (isMoney(lines[n])) return parseMoneyAny(lines[n]);
      return null;
    };
    const chargeback = value(/^Chargeback amount/i);
    const deductedAmount = deducted ? -parseFloat(deducted[1].replace(/,/g, "")) : null;
    const errorTotal = chargeback ?? deductedAmount;
    const flagged = items.filter((x) => x.flags.length || x.flaggedOptions.length);
    const status = statusLine ? statusLine.replace(/^Dispute /i, "").toLowerCase() : disputeOffered ? "available" : null;
    const errorCharges = (flagged.length ? flagged : issueHeadline ? [null] : []).map((x) => ({
      item: x?.name ?? "",
      options: x?.flaggedOptions ?? [],
      reason: x?.flags[0] ?? (x?.flaggedOptions.length ? "Customisation reported wrong" : issueHeadline),
      disputeStatus: status,
      amount: flagged.length <= 1 ? errorTotal : null,
      customerComment: x?.feedback ?? items.find((y) => y.feedback)?.feedback ?? null
    }));
    const step = (re) => timeline.find((t) => re.test(t.event))?.time ?? null;
    const snapshot = {
      platform: "ubereats",
      orderId,
      placedAtText: dateLine ? [dateLine, timeline[0]?.time].filter(Boolean).join(" ") : null,
      placedAt: uberPlacedAt(dateLine, timeline[0]?.time ?? null),
      status: step(/delivered/i) ? "Delivered" : timeline.at(-1)?.event ?? null,
      disputeStatus: status,
      notice: banner.join(" ").slice(0, 600) || null,
      channel: "Uber Eats",
      fulfillment: timeline.some((t) => /courier|delivered to customer/i.test(t.event)) ? "Uber delivery" : null,
      pickedUp: { actual: step(/courier departs|picked up/i), quoted: null },
      droppedOff: { actual: step(/delivered/i), quoted: null },
      items: items.map(({ qty, name, options, price }) => ({ qty, name, options, price })),
      subtotal: value(/^Sales\b/i),
      tax: value(/^Tax\b/i),
      commissionPct: null,
      commission: value(/^Marketplace Fee/i),
      orderTotal: null,
      errorCharges,
      errorChargeTotal: errorTotal,
      errorCredit: null,
      estimatedPayout: value(/^Net payout/i),
      transactions: [],
      timeline,
      shop
    };
    return { snapshot };
  }

  // src/shared/ids.ts
  var STORE_PARAMS = ["store_id", "storeId", "storeid", "store", "merchant_store_id"];
  var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var UBER_STORE_PARAMS = ["restaurantUUID", "restaurant_uuid", "storeUUID", "store_uuid", "shopUUID", "restaurantId"];
  var ORDER_PARAMS = ["order_id", "orderId", "orderid", "order"];
  function params(url) {
    try {
      const u = new URL(url);
      const hash = u.hash.includes("?") ? new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1)) : null;
      const merged = new URLSearchParams(u.search);
      hash?.forEach((v, k) => merged.append(k, v));
      return merged;
    } catch {
      return new URLSearchParams();
    }
  }
  function findStoreId(url, text, platform2 = "doordash") {
    if (platform2 === "ubereats") {
      const inPath = url.match(new RegExp(`/(?:stores?|restaurants?|shops?|home)/(${UUID})(?:[/?#]|$)`, "i"))?.[1];
      if (inPath) return inPath.toLowerCase();
      const q2 = params(url);
      for (const key of UBER_STORE_PARAMS) {
        const v = q2.get(key);
        if (v && new RegExp(`^${UUID}$`, "i").test(v)) return v.toLowerCase();
      }
      return null;
    }
    const path = url.match(/\/stores?\/(\d{3,32})(?:[/?#]|$)/i)?.[1];
    if (path) return path;
    const q = params(url);
    for (const key of STORE_PARAMS) {
      const v = q.get(key);
      if (v && /^\d{3,32}$/.test(v)) return v;
    }
    return text.match(/\bStore\s*(?:ID|#|number)\s*[:#]?\s*(\d{3,32})\b/i)?.[1] ?? null;
  }
  function findOrderId(url, text) {
    const fromText = text.match(/(?:^|\n)\s*Order:\s*([A-Z0-9]{4,16})\b/)?.[1];
    if (fromText) return fromText;
    const uber = text.match(/(?:^|\n)\s*Order\s+([A-Z0-9]{4,16})\s*(?:\n|$)/)?.[1];
    if (uber) return uber;
    const q = params(url);
    for (const key of ORDER_PARAMS) {
      const v = q.get(key);
      if (v && /^[A-Z0-9-]{4,24}$/i.test(v)) return v;
    }
    return url.match(/\/orders?\/([A-Z0-9]{6,16})(?:[/?#]|$)/i)?.[1] ?? null;
  }

  // src/shared/platform.ts
  function platformFromUrl(url) {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host === "doordash.com" || host.endsWith(".doordash.com")) return "doordash";
    if (host === "ubereats.com" || host.endsWith(".ubereats.com") || host === "uber.com" || host.endsWith(".uber.com")) return "ubereats";
    if (host === "grubhub.com" || host.endsWith(".grubhub.com")) return "grubhub";
    return null;
  }
  function detectPlatform(url, doc) {
    const fromUrl = platformFromUrl(url);
    if (fromUrl) return fromUrl;
    if (doc.querySelector("[data-baseweb]") || /Uber Eats/i.test(doc.title)) return "ubereats";
    return "doordash";
  }

  // src/content/dom.ts
  var ORDER_HEADINGS = {
    doordash: /(^|\n)Order:\s*[A-Z0-9]{4,}/,
    // "Order D2D46" on a line of its own; "Order details" is lower case and never matches.
    ubereats: /(^|\n)Order\s+[A-Z0-9]{4,16}\s*(\n|$)/,
    grubhub: /(^|\n)Order\s*#?\s*[A-Z0-9-]{4,}/
  };
  var PANELS = '[class*="SidesheetBody"], [class*="SidesheetContent"], [data-baseweb="drawer"], [role="dialog"], [aria-modal="true"]';
  var PHOTO_CONTEXT = /photo|picture|image|feedback|comment|evidence/i;
  var MAX_PHOTOS = 3;
  var PHOTO_HOSTS = ["media-platform.cdn4dd.com", ..."" ? [""] : []];
  function originalPhotoUrl(src) {
    const proxied = src.match(/\/cdn-cgi\/image\/[^/]+\/(https?:\/\/.+)$/);
    try {
      const u = new URL(proxied ? proxied[1] : src);
      return PHOTO_HOSTS.includes(u.hostname) && u.pathname.startsWith("/media/cnr_photo_proof/") ? u.href : null;
    } catch {
      return null;
    }
  }
  var linkOf = (el) => el instanceof HTMLImageElement ? originalPhotoUrl(el.currentSrc || el.src) : null;
  function panelAroundHeading(heading) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text.length > 24 || !heading.test(`
${text}
`)) continue;
      for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
        const pos = getComputedStyle(el).position;
        if ((pos === "fixed" || pos === "absolute") && el.getBoundingClientRect().height > 300) return el;
      }
    }
    return null;
  }
  function findOrderRoot(platform2 = "doordash") {
    const heading = ORDER_HEADINGS[platform2];
    for (const el of document.querySelectorAll(PANELS)) {
      if (heading.test(el.innerText)) return el;
    }
    if (platform2 !== "doordash") {
      const panel = panelAroundHeading(heading);
      if (panel) return panel;
    }
    return heading.test(document.body.innerText) ? document.body : null;
  }
  function genericRoot() {
    const candidates = [...document.querySelectorAll(`${PANELS}, [class*="drawer" i]`)].filter(
      (el) => el.getBoundingClientRect().height > 140
    );
    return candidates.find((el) => el.scrollHeight > el.clientHeight + 20) ?? candidates.at(-1) ?? document.documentElement;
  }
  var captureRoot = (platform2 = "doordash") => findOrderRoot(platform2) ?? genericRoot();
  function viewport() {
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  }
  function isRound(el, rect) {
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      const radius = getComputedStyle(e).borderTopLeftRadius;
      const px = radius.endsWith("%") ? parseFloat(radius) / 100 * rect.width : parseFloat(radius);
      if (px >= rect.width * 0.4) return true;
    }
    return false;
  }
  function pictures(root) {
    const out = [];
    for (const el of root.querySelectorAll('img, [role="img"], *')) {
      const isImg = el instanceof HTMLImageElement || el.getAttribute("role") === "img";
      if (!isImg && !getComputedStyle(el).backgroundImage.startsWith("url(")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) continue;
      out.push({ el, rect });
    }
    return out;
  }
  function isCustomerPhoto(p) {
    if (p.rect.width < 48 || p.rect.height < 48 || isRound(p.el, p.rect)) return false;
    if (p.rect.width >= 120 && p.rect.height >= 120) return true;
    for (let e = p.el.parentElement, i = 0; e && i < 4; e = e.parentElement, i++) {
      const text = e.innerText ?? "";
      if (text.length < 600 && PHOTO_CONTEXT.test(text)) return true;
    }
    return false;
  }
  function customerPhotos(root) {
    return pictures(root).filter((p) => linkOf(p.el) !== null || isCustomerPhoto(p)).slice(0, MAX_PHOTOS).map((p) => p.el);
  }
  function customerPhotoLinks(root) {
    return customerPhotos(root).map(linkOf);
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
  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x;
    const h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  // src/content/index.ts
  var platform = () => detectPlatform(location.href, document);
  var parse = (text, on) => on === "ubereats" ? parseUberOrder(text) : parseOrder(text);
  var pageText = (text) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  function buildPayload() {
    const on = platform();
    const root = findOrderRoot(on);
    if (!root) return null;
    const text = root.innerText;
    const { snapshot } = parse(text, on);
    if (!snapshot.orderId) return null;
    return { platform: on, url: location.href, snapshot, redactedText: pageText(text) };
  }
  function buildContext() {
    const on = platform();
    const root = captureRoot(on);
    const text = root.innerText.slice(0, 2e4);
    const collapsed = /Customer feedback/i.test(text) && /(^|\n)View more(\n|$)/i.test(text);
    return {
      platform: on,
      orderId: findOrderId(location.href, text),
      storeId: findStoreId(location.href, document.body.innerText.slice(0, 2e4), on),
      title: document.title,
      url: location.href,
      safeText: pageText(text).slice(0, 9e3),
      photoCount: customerPhotos(root).length,
      photoLinks: customerPhotoLinks(root),
      hint: collapsed ? 'Open "View more" under Customer feedback on the page, then attach again to include every customer photo.' : null
    };
  }
  var settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
  async function frame(top) {
    const on = platform();
    const root = captureRoot(on);
    const scroller = findScroller(root);
    if (top !== null) {
      setScrollTop(scroller, top);
      await settle();
    }
    return { ...scrollMetrics(scroller), viewport: viewport() };
  }
  async function photoFrame(index, scroll) {
    const on = platform();
    const root = captureRoot(on);
    const photo = customerPhotos(root)[index];
    if (!photo) return null;
    const scroller = findScroller(root);
    const { scrollTop, region } = scrollMetrics(scroller);
    if (scroll) {
      setScrollTop(scroller, scrollTop + photo.getBoundingClientRect().top - region.y - 16);
      await settle();
      for (let i = 0; i < 6 && photo instanceof HTMLImageElement && !photo.complete; i++) await settle(250);
    }
    const vp = viewport();
    const shown = intersect(
      { x: photo.getBoundingClientRect().left, y: photo.getBoundingClientRect().top, w: photo.getBoundingClientRect().width, h: photo.getBoundingClientRect().height },
      intersect(scrollMetrics(scroller).region, { x: 0, y: 0, w: vp.innerWidth, h: vp.innerHeight }) ?? { x: 0, y: 0, w: 0, h: 0 }
    );
    if (!shown) return null;
    return { rect: shown, viewport: vp };
  }
  var flag = window;
  if (!flag.__korefiReader) {
    flag.__korefiReader = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "GET_PAYLOAD") {
        sendResponse(buildPayload());
      } else if (msg.type === "GET_CAPTURE_CONTEXT") {
        sendResponse(buildContext());
      } else if (msg.type === "SCROLL_FRAME") {
        void frame(msg.top).then(sendResponse, () => sendResponse(null));
        return true;
      } else if (msg.type === "PHOTO_FRAME") {
        void photoFrame(msg.index, msg.scroll).then(sendResponse, () => sendResponse(null));
        return true;
      }
      return false;
    });
  }
})();
