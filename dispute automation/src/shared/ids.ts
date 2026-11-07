// Finds the store and order identifiers from the page address and text. Both are optional:
// the assistant still produces a response when either is missing.

const STORE_PARAMS = ['store_id', 'storeId', 'storeid', 'store', 'merchant_store_id'];
// Uber Eats Manager identifies a shop by UUID, in the path or the query.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UBER_STORE_PARAMS = ['restaurantUUID', 'restaurant_uuid', 'storeUUID', 'store_uuid', 'shopUUID', 'restaurantId'];
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

export function findStoreId(url: string, text: string, platform = 'doordash'): string | null {
  if (platform === 'ubereats') {
    const inPath = url.match(new RegExp(`/(?:stores?|restaurants?|shops?|home)/(${UUID})(?:[/?#]|$)`, 'i'))?.[1];
    if (inPath) return inPath.toLowerCase();
    const q = params(url);
    for (const key of UBER_STORE_PARAMS) {
      const v = q.get(key);
      if (v && new RegExp(`^${UUID}$`, 'i').test(v)) return v.toLowerCase();
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

export function findOrderId(url: string, text: string): string | null {
  const fromText = text.match(/(?:^|\n)\s*Order:\s*([A-Z0-9]{4,16})\b/)?.[1];
  if (fromText) return fromText;
  // Uber Eats: "Order D2D46" on a line of its own. "Order details" is lower case, so it never matches.
  const uber = text.match(/(?:^|\n)\s*Order\s+([A-Z0-9]{4,16})\s*(?:\n|$)/)?.[1];
  if (uber) return uber;
  const q = params(url);
  for (const key of ORDER_PARAMS) {
    const v = q.get(key);
    if (v && /^[A-Z0-9-]{4,24}$/i.test(v)) return v;
  }
  return url.match(/\/orders?\/([A-Z0-9]{6,16})(?:[/?#]|$)/i)?.[1] ?? null;
}
