import type { useRouter } from "expo-router";

type Router = ReturnType<typeof useRouter>;

/**
 * router.back() that still works after a hard refresh or a deep link.
 *
 * On web especially, reloading a screen throws away the in-app navigation
 * history, so `router.back()` becomes a silent no-op and the back button
 * looks broken. This checks whether there's actually somewhere to go back
 * to and otherwise navigates to a concrete fallback route.
 */
export function goBack(router: Router, fallback: string = "/fashion") {
  const canGoBack =
    typeof (router as any).canGoBack === "function" ? (router as any).canGoBack() : true;
  if (canGoBack) {
    router.back();
  } else {
    router.replace(fallback as any);
  }
}
