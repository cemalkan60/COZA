import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Image, type ImageContentFit } from "expo-image";

import { fashionImageSource, FASHION_IMAGE_CACHE_POLICY } from "./RetryImage";

// See RetryImage's comment for why this retry-with-cache-bust dance (and
// the native-only browser User-Agent header / cache bypass, both carried
// by the fashionImageSource + FASHION_IMAGE_CACHE_POLICY helpers) is
// needed -- this component can't just reuse RetryImage directly (it's
// wrapped in the pan/pinch gesture view below and needs its own `uri`
// prop name kept stable for callers), so the same handful of lines are
// duplicated here instead.
const MAX_IMAGE_RETRIES = 2;
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from "react-native-reanimated";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
// How much one press of the +/- zoom button changes the scale (see
// ZoomableImageHandle below) — independent of pinch/double-tap, which use
// their own gesture-driven scale and DOUBLE_TAP_SCALE respectively.
const BUTTON_ZOOM_STEP = 1;

function clamp(value: number, min: number, max: number) {
  "worklet";
  return Math.min(Math.max(value, min), max);
}

// Imperative +/- zoom controls for a click-based UI (buttons), alongside the
// gesture-based pinch/double-tap this component already supports — a parent
// screen holds a ref per visible page and calls these from its own +/-
// buttons (see app/fashion/brand/[id].tsx's viewer toolbar).
export type ZoomableImageHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
};

// Pinch-to-zoom + pan + double-tap image, meant for a full-screen viewer page.
// `onZoomChange` lets the parent (e.g. a paging FlatList) disable its own
// horizontal swipe while the image is zoomed in, so panning moves the photo
// instead of flipping to the next one.
export const ZoomableImage = forwardRef<
  ZoomableImageHandle,
  {
    uri: string;
    width: number;
    height: number;
    contentFit?: ImageContentFit;
    onZoomChange?: (zoomed: boolean) => void;
    // A single tap on the photo while it's NOT zoomed (used by the viewer
    // to close on tap). Ignored while zoomed — there a single tap resets.
    onTap?: () => void;
  }
>(function ZoomableImage({ uri, width, height, contentFit = "contain", onZoomChange, onTap }, ref) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  // Gates the pan gesture: while not zoomed, pan must stay fully disabled
  // (not just a no-op) so a parent paging FlatList keeps owning horizontal
  // drags. Only re-enable single-finger panning once actually zoomed in.
  const [isZoomed, setIsZoomed] = useState(false);
  const [imgAttempt, setImgAttempt] = useState(0);
  useEffect(() => {
    setImgAttempt(0);
  }, [uri]);
  const bustedUri = imgAttempt === 0 ? uri : `${uri}${uri.includes("?") ? "&" : "?"}_retry=${imgAttempt}`;

  const notifyZoom = (next: boolean) => {
    setIsZoomed(next);
    onZoomChange?.(next);
  };

  const reset = () => {
    "worklet";
    scale.value = withTiming(1);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    runOnJS(notifyZoom)(false);
  };

  const boundsFor = (s: number) => {
    "worklet";
    return {
      x: Math.max(0, (width * (s - 1)) / 2),
      y: Math.max(0, (height * (s - 1)) / 2),
    };
  };

  // Plain JS-thread version of the above, for the +/- button handlers below
  // (a Pressable's onPress always runs on the JS thread already, so this
  // sets shared values directly rather than going through a gesture
  // worklet). `boundsFor`/`clamp` are also callable directly like this —
  // "worklet" only matters when the reanimated babel plugin needs a
  // UI-thread copy for a gesture callback — but keeping this path visibly
  // separate from `reset` (used by the gesture handlers below) makes the
  // two call sites easy to tell apart at a glance.
  const zoomTo = (nextScale: number) => {
    const target = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (target <= MIN_SCALE) {
      scale.value = withTiming(1);
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedScale.value = 1;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
      notifyZoom(false);
      return;
    }
    const bounds = boundsFor(target);
    const tx = clamp(translateX.value, -bounds.x, bounds.x);
    const ty = clamp(translateY.value, -bounds.y, bounds.y);
    scale.value = withTiming(target);
    translateX.value = withTiming(tx);
    translateY.value = withTiming(ty);
    savedScale.value = target;
    savedTranslateX.value = tx;
    savedTranslateY.value = ty;
    notifyZoom(true);
  };

  // Zoom so that the image point currently under (focalX, focalY) — an
  // offset from the viewer's centre — stays put. Used by web mouse-wheel
  // zoom so it tracks the cursor instead of always zooming to the middle.
  const zoomToward = (nextScale: number, focalX: number, focalY: number) => {
    const s0 = savedScale.value;
    const target = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (target <= MIN_SCALE) {
      zoomTo(MIN_SCALE);
      return;
    }
    const ratio = target / s0;
    const bounds = boundsFor(target);
    const tx = clamp(focalX - ratio * (focalX - savedTranslateX.value), -bounds.x, bounds.x);
    const ty = clamp(focalY - ratio * (focalY - savedTranslateY.value), -bounds.y, bounds.y);
    scale.value = withTiming(target, { duration: 90 });
    translateX.value = withTiming(tx, { duration: 90 });
    translateY.value = withTiming(ty, { duration: 90 });
    savedScale.value = target;
    savedTranslateX.value = tx;
    savedTranslateY.value = ty;
    notifyZoom(true);
  };

  const containerRef = useRef<any>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    // RNW may hand back the component instance rather than the node.
    const raw: any = containerRef.current;
    const el: HTMLElement | null =
      raw && typeof raw.addEventListener === "function"
        ? raw
        : (raw && (raw._nativeNode || raw.node)) || null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      try {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const focalX = e.clientX - rect.left - rect.width / 2;
        const focalY = e.clientY - rect.top - rect.height / 2;
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        zoomToward(savedScale.value * factor, focalX, focalY);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomTo(savedScale.value + BUTTON_ZOOM_STEP),
      zoomOut: () => zoomTo(savedScale.value - BUTTON_ZOOM_STEP),
      resetZoom: () => zoomTo(MIN_SCALE),
    }),
    [], // shared values are stable refs — this handle never needs to change
  );

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
    })
    .onEnd(() => {
      if (scale.value <= 1) {
        reset();
        return;
      }
      savedScale.value = scale.value;
      const bounds = boundsFor(scale.value);
      translateX.value = withTiming(clamp(translateX.value, -bounds.x, bounds.x));
      translateY.value = withTiming(clamp(translateY.value, -bounds.y, bounds.y));
      savedTranslateX.value = clamp(translateX.value, -bounds.x, bounds.x);
      savedTranslateY.value = clamp(translateY.value, -bounds.y, bounds.y);
      runOnJS(notifyZoom)(true);
    });

  const pan = Gesture.Pan()
    .enabled(isZoomed)
    .minPointers(1)
    .maxPointers(2)
    .onUpdate((e) => {
      if (savedScale.value <= 1) return;
      const bounds = boundsFor(savedScale.value);
      translateX.value = clamp(savedTranslateX.value + e.translationX, -bounds.x, bounds.x);
      translateY.value = clamp(savedTranslateY.value + e.translationY, -bounds.y, bounds.y);
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (savedScale.value > 1) {
        reset();
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        savedScale.value = DOUBLE_TAP_SCALE;
        runOnJS(notifyZoom)(true);
      }
    });

  const handleTap = () => {
    if (savedScale.value > 1) zoomTo(MIN_SCALE);
    else onTap?.();
  };
  // Fires only if it's NOT the first half of a double-tap (see Exclusive).
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => runOnJS(handleTap)());

  const composed = Gesture.Simultaneous(
    Gesture.Race(Gesture.Exclusive(doubleTap, singleTap), pan),
    pinch,
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    // Fixed-size clipping window, deliberately NOT the element that gets the
    // scale transform below -- if it were the same element, its own clip
    // rect would grow right along with the zoom (scale(2) would make a
    // "clipped to width x height" box visually 2x too), defeating the
    // clip. Needed on web: confirmed live that expo-image's underlying
    // <img> can render at its native intrinsic size rather than being
    // constrained to the `width`/`height` style, leaving an invisible
    // oversized hit area that swallowed clicks meant for anything
    // overlapping it -- including the +/- zoom buttons the parent screen
    // overlays on top of this component.
    <View ref={containerRef} style={{ width, height, overflow: "hidden" }}>
      <GestureDetector gesture={composed}>
        <Animated.View style={[{ width, height }, animatedStyle]}>
          <Image
            source={fashionImageSource(bustedUri)}
            style={{ width, height }}
            contentFit={contentFit}
            cachePolicy={FASHION_IMAGE_CACHE_POLICY}
            onError={() => setImgAttempt((a) => (a < MAX_IMAGE_RETRIES ? a + 1 : a))}
          />
        </Animated.View>
      </GestureDetector>
    </View>
  );
});
