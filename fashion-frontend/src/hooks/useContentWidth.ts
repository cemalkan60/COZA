import { useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

// On desktop web, useWindowDimensions() (window.innerWidth under the hood)
// includes the vertical scrollbar's own width whenever one is visible, but
// document.documentElement.clientWidth -- the space flex layout actually
// gets -- is a few pixels narrower. flex-wrap can't do a partial wrap for
// that sliver, so the very last grid column wraps to the next row entirely,
// leaving what looks like an empty extra column (Cem: "6 sütun yazıyor,
// sadece 5 tanesi sığıyor, sağda boşluk kalıyor"). Every pixel-math grid in
// the app should read width from here instead of straight from
// useWindowDimensions.
export function useContentWidth() {
  const rn = useWindowDimensions();
  const [webWidth, setWebWidth] = useState(() =>
    Platform.OS === "web" && typeof document !== "undefined" ? document.documentElement.clientWidth : rn.width,
  );
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const update = () => setWebWidth(document.documentElement.clientWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return { width: Platform.OS === "web" ? webWidth : rn.width, height: rn.height };
}
