import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import * as Haptics from "expo-haptics";

import { api } from "@/src/api/client";
import { useAuth } from "./AuthContext";

type FavoritesValue = {
  ids: Set<string>;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  count: number;
};

const FavoritesContext = createContext<FavoritesValue | null>(null);

export function FavoritesProvider({ children }: React.PropsWithChildren) {
  const { token } = useAuth();
  const [ids, setIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!token) {
      setIds(new Set());
      return;
    }
    try {
      const data = await api.favoriteIds();
      setIds(new Set(data.product_ids));
    } catch {
      // keep existing
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (id: string) => {
      const has = ids.has(id);
      const next = new Set(ids);
      if (has) next.delete(id);
      else next.add(id);
      setIds(next);
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (has) await api.removeFavorite(id);
        else await api.addFavorite(id);
      } catch {
        // revert on failure
        setIds(ids);
      }
    },
    [ids],
  );

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  return (
    <FavoritesContext.Provider
      value={{ ids, isFavorite, toggle, refresh, count: ids.size }}
    >
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("useFavorites must be used within FavoritesProvider");
  return ctx;
}
