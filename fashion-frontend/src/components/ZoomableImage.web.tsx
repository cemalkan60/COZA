import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import { Image, type ImageContentFit } from "expo-image";

import { fashionImageSource } from "./RetryImage";

// Web build of ZoomableImage. Reanimated + gesture-handler drive the native
// version; on web there's no touch pinch and reanimated transforms have been
// unreliable, so this is plain React state + DOM events: mouse wheel zooms
// toward the cursor, drag pans once zoomed, double-click toggles.
const MIN = 1;
const MAX = 6;

export type ZoomableImageHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
};

export const ZoomableImage = forwardRef<
  ZoomableImageHandle,
  {
    uri: string;
    width: number;
    height: number;
    contentFit?: ImageContentFit;
    onZoomChange?: (zoomed: boolean) => void;
    onTap?: () => void;
  }
>(function ZoomableImage({ uri, width, height, contentFit = "contain", onZoomChange, onTap }, ref) {
  const wrapRef = useRef<any>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const st = useRef(t);
  st.current = t;

  const notify = (s: number) => onZoomChange?.(s > 1.001);

  const apply = (s: number, x: number, y: number) => {
    s = Math.min(MAX, Math.max(MIN, s));
    if (s <= MIN) {
      setT({ s: 1, x: 0, y: 0 });
      notify(1);
      return;
    }
    const mx = Math.max(0, (width * (s - 1)) / 2);
    const my = Math.max(0, (height * (s - 1)) / 2);
    setT({ s, x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) });
    notify(s);
  };

  // Zoom so the image point under (fx,fy) — offset from the wrapper centre —
  // stays put. transform is `translate(x,y) scale(s)` about the centre.
  const zoomToward = (ns: number, fx: number, fy: number) => {
    const cur = st.current;
    const target = Math.min(MAX, Math.max(MIN, ns));
    if (target <= MIN) {
      apply(MIN, 0, 0);
      return;
    }
    const r = target / cur.s;
    apply(target, fx - r * (fx - cur.x), fy - r * (fy - cur.y));
  };

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomToward(st.current.s + 0.6, 0, 0),
      zoomOut: () => zoomToward(st.current.s - 0.6, 0, 0),
      resetZoom: () => apply(MIN, 0, 0),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const el: HTMLElement | null = wrapRef.current || null;
    if (!el || typeof el.addEventListener !== "function") return;

    const focal = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return { fx: e.clientX - rect.left - rect.width / 2, fy: e.clientY - rect.top - rect.height / 2 };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { fx, fy } = focal(e as unknown as MouseEvent);
      zoomToward(st.current.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), fx, fy);
    };

    let drag: { x: number; y: number; ox: number; oy: number } | null = null;
    let moved = false;
    const onDown = (e: MouseEvent) => {
      moved = false;
      if (st.current.s > 1) drag = { x: e.clientX, y: e.clientY, ox: st.current.x, oy: st.current.y };
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 2 || Math.abs(e.clientY - drag.y) > 2) moved = true;
      apply(st.current.s, drag.ox + (e.clientX - drag.x), drag.oy + (e.clientY - drag.y));
    };
    const onUp = () => {
      drag = null;
    };
    const onClick = (e: MouseEvent) => {
      // zoomed, or just finished a drag -> keep the click to ourselves so the
      // viewer's "tap outside closes" Pressable doesn't fire. Clean click on
      // an un-zoomed photo -> let it bubble (that's "tap photo to close").
      if (st.current.s > 1 || moved) {
        e.stopPropagation();
        if (!moved && st.current.s > 1) apply(MIN, 0, 0); // click while zoomed = reset
      } else {
        onTap?.();
      }
      moved = false;
    };
    const onDbl = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (st.current.s > 1) {
        apply(MIN, 0, 0);
      } else {
        const { fx, fy } = focal(e);
        zoomToward(2.5, fx, fy);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    el.addEventListener("click", onClick);
    el.addEventListener("dblclick", onDbl);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.removeEventListener("click", onClick);
      el.removeEventListener("dblclick", onDbl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  return (
    <View
      ref={wrapRef}
      // @ts-expect-error web-only style props
      style={{ width, height, overflow: "hidden", cursor: t.s > 1 ? "grab" : "zoom-in", touchAction: "none" }}
    >
      <View style={{ width, height, transform: [{ translateX: t.x }, { translateY: t.y }, { scale: t.s }] }}>
        <Image source={fashionImageSource(uri)} style={{ width, height }} contentFit={contentFit} />
      </View>
    </View>
  );
});
