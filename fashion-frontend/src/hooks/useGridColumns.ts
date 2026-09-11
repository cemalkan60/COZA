import { useCallback, useEffect, useState } from "react";

import { storage } from "@/src/utils/storage";

const KEY = "coza.gridCols";
const OPTIONS = [2, 3, 4, 5, 6] as const;
const DEFAULT_COLS = 6; // matches the grid's original fixed layout

/**
 * Persisted, shared "how many columns" preference for photo grids
 * (COZA-YOL-HARITASI.md D1). One setting for the whole app — a design
 * choice made once (e.g. "3 sütun") should stick everywhere, not need
 * re-picking per screen.
 */
export function useGridColumns() {
  const [cols, setCols] = useState<number>(DEFAULT_COLS);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem<number>(KEY, DEFAULT_COLS);
      if (saved && OPTIONS.includes(saved as any)) setCols(saved);
    })();
  }, []);

  const cycle = useCallback(() => {
    setCols((cur) => {
      const i = OPTIONS.indexOf(cur as any);
      const next = OPTIONS[(i + 1) % OPTIONS.length];
      storage.setItem(KEY, next);
      return next;
    });
  }, []);

  return { cols, cycle, widthPct: `${100 / cols}%` as const };
}
