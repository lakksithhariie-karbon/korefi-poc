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
  function valueAfter(lines, i, window = 2) {
    const trailing = lines[i].match(MONEY_TRAILING);
    if (trailing) return parseMoney(trailing[1].replace(/\s+/g, ""));
    for (let j = i + 1; j <= i + window && j < lines.length; j++) {
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

  // src/shared/rules.ts
  var DISPUTE_WINDOW_DAYS = 14;
  var WINDOW_DAYS = { doordash: DISPUTE_WINDOW_DAYS };
  var DECIDED = /^(approved|denied|rejected|declined)$/;
  var DAY_MS = 864e5;
  function assessRules(snapshot, now = /* @__PURE__ */ new Date()) {
    let deadlineIso = null;
    let daysLeft = null;
    let expired = false;
    const platform = snapshot.platform ?? "doordash";
    const window = WINDOW_DAYS[platform];
    if (snapshot.placedAt && window) {
      const deadline = new Date(new Date(snapshot.placedAt).getTime() + window * DAY_MS);
      deadlineIso = deadline.toISOString();
      const remaining = deadline.getTime() - now.getTime();
      daysLeft = Math.floor(remaining / DAY_MS);
      expired = remaining < 0;
    }
    const openErrorCharges = snapshot.errorCharges.filter(
      (c) => !(c.disputeStatus && DECIDED.test(c.disputeStatus))
    );
    const decided = snapshot.errorCharges.length > 0 && openErrorCharges.length === 0;
    const errorTotal = openErrorCharges.reduce((sum, c) => sum + Math.abs(c.amount ?? 0), 0);
    const reasons = openErrorCharges.map((c) => c.reason ?? "").join(" ");
    let faultHint = null;
    if (platform !== "doordash") {
      if (/missing|incorrect|wrong|customi[sz]ation/i.test(reasons)) {
        faultHint = "Wrong or missing items are usually charged to the restaurant. A dispute needs proof the order was made as ordered.";
      }
    } else if (/missing|incorrect|wrong/i.test(reasons)) {
      faultHint = "Missing or incorrect items are charged to the merchant by default (Marketplace addendum s8). A dispute needs proof the item was made and handed off.";
    } else if (/late|never|not delivered|damaged|spilled|cold/i.test(reasons)) {
      faultHint = "Delivery-related reasons may be DoorDash's cost rather than the merchant's. Check the Dasher pick-up and drop-off times.";
    }
    return {
      deadlineIso,
      daysLeft,
      expired,
      decided,
      openErrorCharges,
      errorTotal: Math.round(errorTotal * 100) / 100,
      faultHint
    };
  }

  // src/shared/storage.ts
  var MAX_CASES = 120;
  async function listCases() {
    const { cases } = await chrome.storage.local.get("cases");
    return cases ?? [];
  }
  async function upsertCase(record) {
    const cases = await listCases();
    const i = cases.findIndex((c) => c.id === record.id);
    if (i >= 0) cases[i] = record;
    else cases.unshift(record);
    await chrome.storage.local.set({ cases: cases.slice(0, MAX_CASES) });
  }

  // src/background.ts
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== void 0) void chrome.sidePanel.open({ tabId: tab.id });
  });
  var queue = Promise.resolve();
  function enqueue(job) {
    queue = queue.then(job).catch((err) => console.error("capture failed", err));
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CAPTURE_NOW") enqueue(() => capture(msg.tabId));
    return false;
  });
  function fail(reason) {
    chrome.runtime.sendMessage({ type: "CAPTURE_FAILED", reason }).catch(() => {
    });
  }
  async function askPage(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tabId, msg);
    }
  }
  async function capture(tabId) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return fail("That tab is no longer open.");
    }
    let payload;
    let context;
    try {
      payload = await askPage(tabId, { type: "GET_PAYLOAD" });
      context = await askPage(tabId, { type: "GET_CAPTURE_CONTEXT" });
    } catch {
      const host = tab.url ? ` (${new URL(tab.url).hostname})` : "";
      return fail(`Could not read this tab${host}. ${NEEDS_ACCESS}`);
    }
    const platform = payload?.platform ?? context?.platform ?? "doordash";
    const orderId = payload?.snapshot.orderId || context?.orderId || `SCREENSHOT-${Date.now().toString(36).toUpperCase()}`;
    const snapshot = payload?.snapshot ?? { ...parseOrder(`Order: ${orderId}`).snapshot, platform };
    const redactedText = payload?.redactedText ?? context?.safeText ?? "";
    const { image, note } = await takeScreenshot(tab);
    const photos = context?.photoCount ? await takeCustomerPhotos(tab, context.photoCount, context.photoLinks ?? []) : [];
    const record = {
      id: `${orderId}-${Date.now().toString(36)}`,
      platform,
      orderId,
      storeId: context?.storeId ?? null,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      trigger: "manual",
      url: payload?.url ?? context?.url ?? tab.url ?? "",
      snapshot,
      redactedText,
      image,
      imageNote: note || null,
      photos,
      facts: assessRules(snapshot),
      assessment: null,
      status: "new"
    };
    await upsertCase(record);
    chrome.runtime.sendMessage({ type: "CASE_CAPTURED", caseId: record.id }).catch(() => {
    });
  }
  var MAX_FRAMES = 14;
  var CAPTURE_GAP_MS = 600;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var withheld = (why) => ({ image: null, note: `No screenshot: ${why}` });
  var NEEDS_ACCESS = "Chrome has not let KoreFi see this tab yet. Tap Screenshot and choose Allow when Chrome asks.";
  async function takeScreenshot(tab) {
    if (!tab.active || tab.id === void 0 || tab.windowId === void 0) {
      return { image: null, note: "No screenshot: the order tab is not the active tab. Switch to it and capture again." };
    }
    const tabId = tab.id;
    const ask = (top) => askPage(tabId, { type: "SCROLL_FRAME", top });
    let start = null;
    try {
      start = await ask(null);
      if (!start) return withheld("the page could not be read.");
      const maxTop = Math.max(0, start.scrollHeight - start.clientHeight);
      const stride = Math.max(100, start.clientHeight - 40);
      const tops = [];
      for (let t = 0; t < maxTop; t += stride) tops.push(t);
      tops.push(maxTop);
      let note = null;
      if (tops.length > MAX_FRAMES) {
        tops.length = MAX_FRAMES;
        note = `Screenshot covers the first ${MAX_FRAMES} screens of a very long order.`;
      }
      let sheet = null;
      let lastShot = 0;
      for (const top of tops) {
        const before = await ask(top);
        if (!before) return withheld("the page could not be read.");
        await sleep(Math.max(0, CAPTURE_GAP_MS - (Date.now() - lastShot)));
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        lastShot = Date.now();
        const after = await ask(null);
        if (!after || Math.abs(after.scrollTop - before.scrollTop) > 1 || !rectsMatch([before.region], [after.region])) {
          return withheld("the page moved while capturing. Leave it alone for a few seconds and capture again.");
        }
        sheet = await paintFrame(sheet, raw, before, maxTop);
      }
      return { image: sheet ? await finish(sheet) : null, note };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/activeTab|all_urls|cannot access/i.test(msg)) {
        return { image: null, note: `No screenshot. ${NEEDS_ACCESS}` };
      }
      return { image: null, note: `No screenshot: ${msg}` };
    } finally {
      if (start) await ask(start.scrollTop).catch(() => {
      });
    }
  }
  async function takeCustomerPhotos(tab, count, links) {
    if (tab.id === void 0 || tab.windowId === void 0) return [];
    const tabId = tab.id;
    const photos = [];
    let start = null;
    try {
      start = await askPage(tabId, { type: "SCROLL_FRAME", top: null });
      for (let i = 0; i < Math.min(count, 3); i++) {
        const link = links[i];
        if (link) {
          try {
            photos.push(await downloadPhoto(link));
            continue;
          } catch (err) {
            console.warn("photo download failed, cropping the screenshot instead", err);
          }
        }
        const before = await askPage(tabId, { type: "PHOTO_FRAME", index: i, scroll: true });
        if (!before) continue;
        await sleep(CAPTURE_GAP_MS);
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        const after = await askPage(tabId, { type: "PHOTO_FRAME", index: i, scroll: false });
        if (!after || !rectsMatch([before.rect], [after.rect])) continue;
        photos.push(await cropPhoto(raw, before));
      }
    } catch (err) {
      console.warn("customer photos skipped", err);
    } finally {
      if (start) await askPage(tabId, { type: "SCROLL_FRAME", top: start.scrollTop }).catch(() => {
      });
    }
    return photos;
  }
  var MAX_PHOTO_BYTES = 2e7;
  async function downloadPhoto(link) {
    const res = await fetch(link, { credentials: "omit" });
    if (!res.ok) throw new Error(`photo download: HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/") || blob.size > MAX_PHOTO_BYTES) throw new Error(`photo download: ${blob.type}, ${blob.size} bytes`);
    const bitmap = await createImageBitmap(blob);
    const k = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const out = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
    out.getContext("2d").drawImage(bitmap, 0, 0, out.width, out.height);
    return blobToDataUrl(await out.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
  }
  async function cropPhoto(rawDataUrl, f) {
    const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
    const scale = bitmap.width / f.viewport.innerWidth;
    const sx = Math.max(0, Math.round(f.rect.x * scale));
    const sy = Math.max(0, Math.round(f.rect.y * scale));
    const sw = Math.min(Math.round(f.rect.w * scale), bitmap.width - sx);
    const sh = Math.min(Math.round(f.rect.h * scale), bitmap.height - sy);
    const k = Math.min(1, 1600 / sw);
    const out = new OffscreenCanvas(Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)));
    out.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return blobToDataUrl(await out.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
  }
  function rectsMatch(a, b) {
    if (a.length !== b.length) return false;
    return a.every((r, i) => ["x", "y", "w", "h"].every((k) => Math.abs(r[k] - b[i][k]) <= 2));
  }
  async function paintFrame(sheet, rawDataUrl, f, maxTop) {
    const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
    const scale = bitmap.width / f.viewport.innerWidth;
    const sx = Math.max(0, Math.round(f.region.x * scale));
    const sy = Math.max(0, Math.round(f.region.y * scale));
    const sw = Math.min(Math.round(f.region.w * scale), bitmap.width - sx);
    const sh = Math.min(Math.round(f.region.h * scale), bitmap.height - sy);
    const next = sheet ?? {
      canvas: new OffscreenCanvas(sw, Math.round((maxTop + f.region.h) * scale)),
      scale,
      painted: 0
    };
    const dy = Math.round(f.scrollTop * scale);
    next.canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, dy, sw, sh);
    next.painted = Math.max(next.painted, Math.min(dy + sh, next.canvas.height));
    return next;
  }
  async function finish(sheet) {
    const k = Math.min(1, 1100 / sheet.canvas.width);
    const out = new OffscreenCanvas(Math.round(sheet.canvas.width * k), Math.round(sheet.painted * k));
    out.getContext("2d").drawImage(sheet.canvas, 0, 0, sheet.canvas.width, sheet.painted, 0, 0, out.width, out.height);
    return blobToDataUrl(await out.convertToBlob({ type: "image/jpeg", quality: 0.72 }));
  }
  async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return `data:${blob.type};base64,${btoa(bin)}`;
  }
})();
