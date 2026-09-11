import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

/**
 * Drives the Settings "Install App" row (COZA-YOL-HARITASI.md, I1: PWA —
 * installability only, no offline caching — see public/manifest.json and
 * public/sw.js).
 *
 * - "available": Android/Chrome/desktop — the browser gave us an install
 *   prompt we can trigger with a button.
 * - "ios": iOS Safari never exposes that prompt (Apple's rule, not ours) —
 *   show manual "Share > Add to Home Screen" instructions instead.
 * - "installed": already running as a standalone app — nothing to offer.
 * - "unsupported": native app, SSR, or a browser that hasn't offered the
 *   install prompt (yet, or ever) — hide the row.
 */
type Status = "available" | "ios" | "installed" | "unsupported";

export function usePwaInstall(): { status: Status; promptInstall: () => Promise<void> } {
  const [status, setStatus] = useState<Status>("unsupported");
  const [deferred, setDeferred] = useState<any>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const isStandalone =
      (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
      (window.navigator as any).standalone === true;
    if (isStandalone) {
      setStatus("installed");
      return;
    }

    const ua = window.navigator?.userAgent || "";
    // iPadOS 13+ Safari reports a desktop-Mac UA; touch support is the tell.
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && (navigator as any).maxTouchPoints > 1);
    if (isIOS) setStatus("ios");

    const onPrompt = (e: any) => {
      e.preventDefault();
      setDeferred(e);
      setStatus("available");
    };
    const onInstalled = () => {
      setDeferred(null);
      setStatus("installed");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    deferred.prompt();
    try {
      await deferred.userChoice;
    } catch {
      // ignore — user dismissed it
    }
    setDeferred(null);
  }, [deferred]);

  return { status, promptInstall };
}
