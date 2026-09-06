import React, { useEffect, useState } from "react";
import { Image, type ImageProps } from "expo-image";

// Neither caching (query-bust retries, cachePolicy="none") nor a guaranteed
// clean process (Force Stop from Android Settings, not just a task-switcher
// swipe) fixed collections staying permanently blank in the app while the
// exact same photo loaded fine in the phone's own browser at the same
// moment, same network. That combination rules out anything client-side
// cached -- it points at the REQUEST itself being treated differently.
//
// The one concrete difference: our backend (gemini_client.py's
// _IMG_DOWNLOAD_HEADERS, used whenever it downloads a photo itself) always
// sends a real browser User-Agent, and so does an actual browser tab --
// but expo-image's native Android loader sends no User-Agent override at
// all, which defaults to something like "okhttp/4.x". Cloudflare (fronting
// our R2 bucket's public r2.dev domain) is known to bot-block/challenge
// exactly that kind of generic HTTP-client signature while waving through
// anything that looks like a browser, even though the object itself is
// perfectly fine and public. Sending the same browser User-Agent the
// backend already uses successfully is the fix this points to.
export const FASHION_IMAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
};

// Retrying on error with a cache-busting query param (instead of the same
// URI) hands expo-image a fresh cache key, so a genuinely-transient
// failure gets one or two real second chances at the network instead of
// being remembered as broken on this device forever. MAX_RETRIES caps it
// so a truly dead/missing URL still just settles into a normal load
// failure (whatever the caller's placeholder/empty state already does)
// rather than retrying forever.
const MAX_RETRIES = 2;

type Props = Omit<ImageProps, "source"> & { uri: string | undefined | null };

export default function RetryImage({ uri, ...rest }: Props) {
  const [attempt, setAttempt] = useState(0);

  // A new `uri` (e.g. this card recycled to a different collection) always
  // starts its own fresh retry budget rather than inheriting the previous
  // photo's attempt count.
  useEffect(() => {
    setAttempt(0);
  }, [uri]);

  if (!uri) return null;

  const bustedUri = attempt === 0 ? uri : `${uri}${uri.includes("?") ? "&" : "?"}_retry=${attempt}`;

  return (
    <Image
      {...rest}
      source={{ uri: bustedUri, headers: FASHION_IMAGE_HEADERS }}
      // Bypass the disk cache entirely for these photos. A stale/failed
      // disk-cache entry from before the R2 object recovered was suspected
      // as one way this could keep failing forever on a given device even
      // after the underlying photo is fine again everywhere else; forcing
      // every load through the network (no disk read, no disk write) rules
      // that out completely rather than relying on the cache-busting query
      // param above to always be enough on every OS/version.
      cachePolicy="none"
      onError={() => {
        setAttempt((a) => (a < MAX_RETRIES ? a + 1 : a));
      }}
    />
  );
}
