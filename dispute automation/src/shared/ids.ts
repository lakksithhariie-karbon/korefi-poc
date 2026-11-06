// Finds the DoorDash store and order identifiers from the page address and text. Both are optional:
// the assistant still produces a response when either is missing.

const STORE_PARAMS = ['store_id', 'storeId', 'storeid', 'store', 'merchant_store_id'];
const ORDER_PARAMS = ['order_id', 'orderId', 'orderid', 'order'];

function params(url: string): URLSearchParams {
  try {
    const u = new URL(url);
    const hash = u.hash.includes('?') ? new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1)) : null;
    const merged = new URLSearchParams(u.search);
    hash?.forEach((v, k) => merged.append(k, v));
    return merged;
  } catch {
    return new URLSearchParams();
  }
}

export function findStoreId(url: string, text: string): string | null {
  const path = url.match(/\/stores?\/(\d{3,32})(?:[/?#]|$)/i)?.[1];
  if (path) return path;
  const q = params(url);
  for (const key of STORE_PARAMS) {
    const v = q.get(key);
    if (v && /^\d{3,32}$/.test(v)) return v;
  }
  return text.match(/\bStore\s*(?:ID|#|number)\s*[:#]?\s*(\d{3,32})\b/i)?.[1] ?? null;
}

export function findOrderId(url: string, text: string): string | null {
  const fromText = text.match(/(?:^|\n)\s*Order:\s*([A-Z0-9]{4,16})\b/)?.[1];
  if (fromText) return fromText;
  const q = params(url);
  for (const key of ORDER_PARAMS) {
    const v = q.get(key);
    if (v && /^[A-Z0-9-]{4,24}$/i.test(v)) return v;
  }
  return url.match(/\/orders?\/([A-Z0-9]{6,16})(?:[/?#]|$)/i)?.[1] ?? null;
}
