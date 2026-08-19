import React, { useState } from "react";
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

function clamp(value: number, min: number, max: number) {
  "worklet";
  return Math.min(Math.max(value, min), max);
}

// Pinch-to-zoom + pan + double-tap image, meant for a full-screen viewer page.
// `onZoomChange` lets the parent (e.g. a paging FlatList) disable its own
// horizontal swipe while the image is zoomed in, so panning moves the photo
// instead of flipping to the next one.
export function ZoomableImage({
  uri,
  width,
  height,
  contentFit = "contain",
  onZoomChange,
}: {
  uri: string;
  width: number;
  height: number;
  contentFit?: ImageContentFit;
  onZoomChange?: (zoomed: boolean) => void;
}) {
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
    <GestureDetector gesture={composed}>
      <Animated.View style={[{ width, height }, animatedStyle]}>
        <Image source={{ uri }} style={{ width, height }} contentFit={contentFit} />
      </Animated.View>
    </GestureDetector>
  );
}
