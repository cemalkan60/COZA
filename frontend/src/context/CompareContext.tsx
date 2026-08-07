import React, { createContext, useCallback, useContext, useState } from "react";
import * as Haptics from "expo-haptics";

type CompareValue = {
  ids: string[];
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  clear: () => void;
  full: boolean;
};

const CompareContext = createContext<CompareValue | null>(null);

export function CompareProvider({ children }: React.PropsWithChildren) {
  const [ids, setIds] = useState<string[]>([]);

  const toggle = useCallback((id: string) => {
    Haptics.selectionAsync();
    setIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id]; // keep newest two
      return [...prev, id];
    });
  }, []);

  const clear = useCallback(() => setIds([]), []);
  const has = useCallback((id: string) => ids.includes(id), [ids]);

  return (
    <CompareContext.Provider value={{ ids, has, toggle, clear, full: ids.length >= 2 }}>
      {children}
    </CompareContext.Provider>
  );
}

export function useCompare() {
  const ctx = useContext(CompareContext);
  if (!ctx) throw new Error("useCompare must be used within CompareProvider");
  return ctx;
}
