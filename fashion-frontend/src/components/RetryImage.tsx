import React, { useEffect, useState } from "react";
import { Image, type ImageProps } from "expo-image";

// expo-image's disk cache remembers a failed fetch for a given URL
// indefinitely -- if a photo was requested even once during the few
// seconds our R2 bucket briefly 503s a file right after upload (see
// image_store.py's cache_image docstring on this), that exact URL then
// keeps "failing" on THIS device forever after, even though the same URL
// serves the photo fine on the web app, on a different phone, or on this
// same phone for a collection it hasn't touched yet. Seen live as: grid
// tiles blank on the unfiltered home feed (always the same handful of
// newest-season URLs) while a filtered view -- which happens to load a
// different, not-yet-poisoned set of URLs -- shows photos fine; also seen
// as a fully blank detail/full-screen viewer. Force-closing the app does
// NOT clear this (expo-image's cache is on disk); only clearing the app's
// storage cache from Android Settings resets it, and only for images
// touched since then.
//
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
      source={{ uri: bustedUri }}
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
