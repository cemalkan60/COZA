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
