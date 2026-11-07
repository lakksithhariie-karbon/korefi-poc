// Which delivery platform a page belongs to. The address decides; page markers are only a fallback for test pages.

export type Platform = 'doordash' | 'ubereats' | 'grubhub';

export const PLATFORM_NAMES: Record<Platform, string> = { doordash: 'DoorDash', ubereats: 'Uber Eats', grubhub: 'Grubhub' };

export function platformFromUrl(url: string): Platform | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'doordash.com' || host.endsWith('.doordash.com')) return 'doordash';
  if (host === 'ubereats.com' || host.endsWith('.ubereats.com') || host === 'uber.com' || host.endsWith('.uber.com')) return 'ubereats';
  if (host === 'grubhub.com' || host.endsWith('.grubhub.com')) return 'grubhub';
  return null;
}

/** Uber Eats Manager is built with Base Web, which marks its components with data-baseweb. */
export function detectPlatform(url: string, doc: Document): Platform {
  const fromUrl = platformFromUrl(url);
  if (fromUrl) return fromUrl;
  if (doc.querySelector('[data-baseweb]') || /Uber Eats/i.test(doc.title)) return 'ubereats';
  return 'doordash';
}
