import { useCallback, useEffect, useState } from "react";

import { storage } from "@/src/utils/storage";

const KEY = "coza.watermark";

/** F4: "Filigran aç/kapa" — one persisted, shared preference for every
 * share/export surface (F1-F3), default ON (COZA + brand watermark). */
export function useWatermarkPref() {
  const [watermark, setWatermarkState] = useState(true);

  useEffect(() => {
    storage.getItem<boolean>(KEY, true).then((v) => setWatermarkState(v ?? true));
  }, []);

  const toggle = useCallback(() => {
    setWatermarkState((cur) => {
      const next = !cur;
      storage.setItem(KEY, next);
      return next;
    });
  }, []);

  return { watermark, toggle };
}
