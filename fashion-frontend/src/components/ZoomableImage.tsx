import React, { forwardRef, useImperativeHandle, useState } from "react";
import { View } from "react-native";
import { Image, type ImageContentFit } from "expo-image";
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
  }
>(function ZoomableImage({ uri, width, height, contentFit = "contain", onZoomChange }, ref) {
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

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomTo(savedScale.value + BUTTON_ZOOM_STEP),
      zoomOut: () => zoomTo(savedScale.value - BUTTON_ZOOM_STEP),
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

  const composed = Gesture.Simultaneous(Gesture.Race(doubleTap, pan), pinch);

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
    <View style={{ width, height, overflow: "hidden" }}>
      <GestureDetector gesture={composed}>
        <Animated.View style={[{ width, height }, animatedStyle]}>
          <Image source={{ uri }} style={{ width, height }} contentFit={contentFit} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
});
