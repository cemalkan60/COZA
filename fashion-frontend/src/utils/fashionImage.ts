import { Platform, Image as RNImage } from "react-native";

// SSR-safe image probe
async function probeImage(url: string): Promise<boolean> {
  if (!url) return false;
  if (typeof window === "undefined") return false;

  if (Platform.OS === "web") {
    return await new Promise<boolean>((resolve) => {
      try {
        const img = new (window as any).Image();
        img.referrerPolicy = "no-referrer";
        let done = false;
        const onOK = () => {
          if (done) return;
          done = true;
          resolve(true);
        };
        const onFail = () => {
          if (done) return;
          done = true;
          resolve(false);
        };
        const t = setTimeout(() => onFail(), 4000);
        img.onload = () => {
          clearTimeout(t);
          onOK();
        };
        img.onerror = () => {
          clearTimeout(t);
          onFail();
        };
        img.src = url;
      } catch {
        resolve(false);
      }
    });
  } else {
    try {
      // @ts-ignore
      const ok = await RNImage.prefetch(url);
      return !!ok;
    } catch {
      return false;
    }
  }
}

// fashion-press.net only ever serves two variants of a photo: the small
// "/wNNN_name.jpg" thumbnail and the full-resolution original at the same
// path with that size prefix stripped (e.g. "/w300_top.jpg" -> "/top.jpg").
// There is no ladder of in-between sizes, so this is the only upgrade to try.
function makeCandidates(original: string): string[] {
  if (!original) return [original];
  const re = /\/w\d+_/;
  if (!re.test(original)) return [original];
  const fullRes = original.replace(re, "/");
  return Array.from(new Set([fullRes, original]));
}

// Try the full-resolution original first; fall back to the low-res thumbnail
// only if the original isn't reachable.
export async function resolveBestImage(original: string): Promise<string> {
  const candidates = makeCandidates(original);
  for (const c of candidates) {
    if (!c) continue;
    const ok = await probeImage(c);
    if (ok) return c;
  }
  return original;
}

// fashion-press.net (and firstview.com) reject image requests that carry a
// foreign Referer header (or otherwise block direct cross-origin loads) —
// that's why these photos render fine on native (RN doesn't send a Referer
// for image loads) but not on web. Route just those hosts' <Image>/<img>
// src through our own backend on web, which fetches the bytes server-side
// and re-serves them from our own origin.
//
// Most photos, though, are already re-hosted on our own Cloudflare R2
// bucket by the time they reach here (see image_store.py) — that's a CDN
// we control, with no Referer restriction, so proxying those through our
// backend too would be pure waste (an extra hop re-downloading/re-streaming
// a photo that's already sitting on a fast public CDN) and, until the
// backend's host allowlist knew about the R2 domain, actively broke every
// R2-cached photo on web (400 from /fashion/image-proxy). Load those, and
// anything else that isn't one of the known Referer-sensitive hosts,
// directly.
const REFERER_SENSITIVE_HOSTS = [/(^|\.)fashion-press\.net$/i, /(^|\.)firstview\.com$/i];

function needsProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return REFERER_SENSITIVE_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

export function fashionImageUri(url: string | undefined | null): string {
  if (!url) return "";
  if (Platform.OS !== "web") return url;
  if (!needsProxy(url)) return url;
  const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
  if (!base) return url;
  return `${base}/api/fashion/image-proxy?url=${encodeURIComponent(url)}`;
}
