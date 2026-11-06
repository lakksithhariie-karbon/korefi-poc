"use strict";
(() => {
  // src/shared/rules.ts
  var DISPUTE_WINDOW_DAYS = 14;
  var DECIDED = /^(approved|denied|rejected|declined)$/;
  var DAY_MS = 864e5;
  function assessRules(snapshot, now = /* @__PURE__ */ new Date()) {
    let deadlineIso = null;
    let daysLeft = null;
    let expired = false;
    if (snapshot.placedAt) {
      const deadline = new Date(new Date(snapshot.placedAt).getTime() + DISPUTE_WINDOW_DAYS * DAY_MS);
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
    if (/missing|incorrect|wrong/i.test(reasons)) {
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

  // src/shared/types.ts
  var DEFAULT_SETTINGS = {
    apiKey: "",
    model: "",
    baseUrl: "",
    captureEnabled: false
  };

  // src/shared/storage.ts
  var MAX_CASES = 40;
  function stableStringify(value) {
    return JSON.stringify(
      value,
      (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v
    );
  }
  async function getSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...settings ?? {} };
  }
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
  chrome.runtime.onInstalled.addListener(() => void updateBadge());
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== void 0) void chrome.sidePanel.open({ tabId: tab.id });
  });
  chrome.runtime.onStartup.addListener(() => void updateBadge());
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) void updateBadge();
  });
  async function updateBadge() {
    const { captureEnabled } = await getSettings();
    await chrome.action.setBadgeText({ text: captureEnabled ? "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#B3261E" });
    await chrome.action.setTitle({
      title: captureEnabled ? "Korefi Dispute Assistant: capturing order pages" : "Korefi Dispute Assistant: capture is off"
    });
  }
  var queue = Promise.resolve();
  function enqueue(job) {
    queue = queue.then(job).catch((err) => console.error("capture failed", err));
  }
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === "ORDER_DETECTED" && sender.tab) {
      const tab = sender.tab;
      enqueue(() => handleDetected(tab, msg.payload, "auto"));
    } else if (msg.type === "CAPTURE_NOW") {
      enqueue(() => handleManual(msg.tabId));
    }
    return false;
  });
  async function readPayload(tabId) {
    const ask = () => chrome.tabs.sendMessage(tabId, { type: "GET_PAYLOAD" });
    try {
      return await ask();
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return await ask();
    }
  }
  async function handleManual(tabId) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return fail("That tab is no longer open.");
    }
    let payload;
    try {
      payload = await readPayload(tabId);
    } catch {
      const host = tab.url ? ` (${new URL(tab.url).hostname})` : "";
      return fail(`Could not read this tab${host}. Click the Korefi icon in the toolbar on the DoorDash order tab, then press Capture now.`);
    }
    if (!payload) return fail("No order is open on this tab. Open an order so its details sheet is showing.");
    await handleDetected(tab, payload, "manual");
  }
  function fail(reason) {
    chrome.runtime.sendMessage({ type: "CAPTURE_FAILED", reason }).catch(() => {
    });
  }
  async function handleDetected(tab, payload, trigger) {
    const settings = await getSettings();
    if (trigger === "auto" && !settings.captureEnabled) return;
    const existing = await listCases();
    const last = existing.find((c) => c.orderId === payload.snapshot.orderId);
    const duplicate = !!last && stableStringify(last.snapshot) === stableStringify(payload.snapshot);
    console.debug("[capture]", trigger, payload.snapshot.orderId, { stored: existing.length, duplicate });
    if (trigger === "auto" && duplicate) return;
    const { image, note } = await takeRedactedScreenshot(tab, payload);
    const record = {
      id: `${payload.snapshot.orderId}-${Date.now().toString(36)}`,
      orderId: payload.snapshot.orderId,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      trigger,
      url: payload.url,
      snapshot: payload.snapshot,
      redactedText: payload.redactedText,
      image,
      imageNote: note,
      facts: assessRules(payload.snapshot),
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
  var withheld = (why) => ({ image: null, note: `Screenshot withheld: ${why}` });
  async function takeRedactedScreenshot(tab, payload) {
    if (!payload.rects) return withheld("personal details could not be located on the page to black out.");
    if (!tab.active || tab.id === void 0 || tab.windowId === void 0) {
      return { image: null, note: "Screenshot skipped: the order tab is not the active tab." };
    }
    const tabId = tab.id;
    const ask = (top) => chrome.tabs.sendMessage(tabId, { type: "SCROLL_FRAME", top });
    let start = null;
    try {
      start = await ask(null);
      if (!start) return withheld("the order sheet is no longer on the page.");
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
        if (!before?.rects) return withheld("personal details could not be located on the page to black out.");
        await sleep(Math.max(0, CAPTURE_GAP_MS - (Date.now() - lastShot)));
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        lastShot = Date.now();
        const after = await ask(null);
        if (!after?.rects || Math.abs(after.scrollTop - before.scrollTop) > 1 || !rectsMatch(before.rects, after.rects)) {
          return withheld("the page moved while capturing. Press Capture now again and leave the page alone for a few seconds.");
        }
        sheet = await paintFrame(sheet, raw, before, maxTop);
      }
      return { image: sheet ? await finish(sheet) : null, note };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/activeTab|all_urls/.test(msg)) {
        return { image: null, note: "Screenshot needs permission: click the Korefi icon in the toolbar on this tab once, then press Capture now." };
      }
      return { image: null, note: `Screenshot failed: ${msg}` };
    } finally {
      if (start) await ask(start.scrollTop).catch(() => {
      });
    }
  }
  function rectsMatch(a, b) {
    if (a.length !== b.length) return false;
    return a.every((r, i) => ["x", "y", "w", "h"].every((k) => Math.abs(r[k] - b[i][k]) <= 2));
  }
  async function paintFrame(sheet, rawDataUrl, f, maxTop) {
    const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
    const scale = bitmap.width / f.viewport.innerWidth;
    const screen = new OffscreenCanvas(bitmap.width, bitmap.height);
    const sctx = screen.getContext("2d");
    sctx.drawImage(bitmap, 0, 0);
    sctx.fillStyle = "#111111";
    for (const r of f.rects ?? []) sctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
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
    next.canvas.getContext("2d").drawImage(screen, sx, sy, sw, sh, 0, dy, sw, sh);
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
