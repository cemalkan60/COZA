import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";

import { api, TOKEN_KEY } from "@/src/api/client";
import { storage } from "@/src/utils/storage";

export type User = { id: string; email: string; name: string; role: "admin" | "viewer" };

type AuthValue = {
  user: User | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: React.PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const saved = await storage.secureGet<string>(TOKEN_KEY, "");
      if (saved) {
        setToken(saved);
        try {
          const me = await api.me();
          setUser(me);
        } catch {
          await storage.secureRemove(TOKEN_KEY);
          setToken(null);
        }
      }
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (data: { token: string; user: User }) => {
    await storage.secureSet(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const data = await api.login(email.trim().toLowerCase(), password);
      await persist(data);
    },
    [persist],
  );

  const signOut = useCallback(async () => {
    await storage.secureRemove(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
