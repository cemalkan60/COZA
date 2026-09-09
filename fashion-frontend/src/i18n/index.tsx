import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { storage } from "@/src/utils/storage";
import { DICTS, Lang, LANGS, tr as TR } from "./locales";

const LANG_KEY = "coza.lang";

// Device language WITHOUT a native module (expo-localization would need an
// APK rebuild, not just an OTA). Hermes ships Intl, and the browser has
// navigator.language, so this works on native and web alike.
function detectLang(): Lang {
  let tag = "";
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale || "";
  } catch {
    tag = "";
  }
  if (!tag && typeof navigator !== "undefined") tag = navigator.language || "";
  const two = tag.slice(0, 2).toLowerCase();
  return two === "en" || two === "es" ? (two as Lang) : "tr";
}

function lookup(dict: any, key: string): string | undefined {
  let cur = dict;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

export type TFunc = (key: string, params?: Record<string, string | number>) => string;

type I18nValue = {
  lang: Lang;
  setLang: (l: Lang) => void;
  langs: typeof LANGS;
  t: TFunc;
  /** "2026-27AW" -> "Sonbahar/Kış 2026-27" (localized). `fallback` (the
   *  backend's season_label) is used for anything that doesn't parse. */
  formatSeason: (code?: string | null, fallback?: string | null) => string;
  ready: boolean;
};

const I18nContext = createContext<I18nValue | null>(null);
const SEASON_RE = /^(\d{4}(?:-\d{2})?)(AW|SS|RESORT|PREFALL)$/;

export function LanguageProvider({ children }: React.PropsWithChildren) {
  const [lang, setLangState] = useState<Lang>("tr");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem<string>(LANG_KEY, "");
      if (saved === "tr" || saved === "en" || saved === "es") setLangState(saved);
      else setLangState(detectLang());
      setReady(true);
    })();
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    storage.setItem(LANG_KEY, l);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = DICTS[lang] || TR;
    const t: TFunc = (key, params) =>
      interpolate(lookup(dict, key) ?? lookup(TR, key) ?? key, params);
    const formatSeason = (code?: string | null, fallback?: string | null) => {
      const m = SEASON_RE.exec((code || "").toUpperCase());
      if (!m) return fallback || code || "";
      return `${t(`season.${m[2]}`)} ${m[1]}`;
    };
    return { lang, setLang, langs: LANGS, t, formatSeason, ready };
  }, [lang, setLang, ready]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within LanguageProvider");
  return ctx;
}
