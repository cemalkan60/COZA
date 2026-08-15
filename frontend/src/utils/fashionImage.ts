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

// Build higher-resolution candidate URLs for a fashion-press.net thumbnail
// (e.g. ".../w300_top.jpg" -> try w1200/w1024/w768 before the low-res original).
function makeCandidates(original: string, sizes: string[] = ["1200", "1024", "768"]): string[] {
  if (!original) return [original];
  const re = /\/w(\d+)_/;
  const m = original.match(re);
  const sized: string[] = [];
  if (m) {
    sizes.forEach((s) => sized.push(original.replace(re, `/w${s}_`)));
  } else {
    sizes.forEach((s) => sized.push(original.replace("/w300_top", `/w${s}_top`)));
  }
  return Array.from(new Set([...sized, original]));
}

// Try highest resolution variants first; fall back to the low-res original
// only if none of the larger sizes are available.
export async function resolveBestImage(original: string, sizes?: string[]): Promise<string> {
  const candidates = makeCandidates(original, sizes);
  for (const c of candidates) {
    if (!c) continue;
    const ok = await probeImage(c);
    if (ok) return c;
  }
  return original;
}
