import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";

import { useTheme } from "@/src/theme/ThemeContext";

export type Datum = { label: string; count: number };

function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const a = (angle - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number) {
  const s = polarToCartesian(cx, cy, r, end);
  const e = polarToCartesian(cx, cy, r, start);
  const largeArc = end - start <= 180 ? "0" : "1";
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y}`;
}

export function DonutChart({
  data,
  total,
  centerLabel,
  centerValue,
}: {
  data: Datum[];
  total: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const { colors, chartPalette, fontSize } = useTheme();
  const size = 200;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const sum = total || data.reduce((a, b) => a + b.count, 0) || 1;

  let angle = 0;
  const segments = data.map((d, i) => {
    const sweep = (d.count / sum) * 360;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    return { path: arcPath(cx, cy, r, start, Math.max(start + 0.5, end)), color: chartPalette[i % chartPalette.length] };
  });

  return (
    <View style={styles.donutRow}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle cx={cx} cy={cy} r={r} stroke={colors.surfaceTertiary} strokeWidth={stroke} fill="none" />
          {segments.map((s, i) => (
            <Path
              key={i}
              d={s.path}
              stroke={s.color}
              strokeWidth={stroke}
              fill="none"
              strokeLinecap="butt"
            />
          ))}
        </Svg>
        <View style={styles.donutCenter} pointerEvents="none">
          <Text style={{ color: colors.onSurface, fontSize: fontSize["2xl"], fontWeight: "800", letterSpacing: -0.5 }}>
            {centerValue ?? sum}
          </Text>
          {!!centerLabel && (
            <Text style={{ color: colors.brandSecondary, fontSize: fontSize.xs, letterSpacing: 1, marginTop: 2 }}>
              {centerLabel.toLocaleUpperCase("tr-TR")}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.legend}>
        {data.map((d, i) => {
          const pct = Math.round((d.count / sum) * 100);
          return (
            <View key={d.label} style={styles.legendRow} testID={`legend-${d.label}`}>
              <View
                style={[styles.swatch, { backgroundColor: chartPalette[i % chartPalette.length] }]}
              />
              <Text numberOfLines={1} style={[styles.legendLabel, { color: colors.onSurfaceSecondary }]}>
                {d.label}
              </Text>
              <Text style={[styles.legendVal, { color: colors.onSurface }]}>{pct}%</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function BarChart({ data }: { data: Datum[] }) {
  const { colors, chartPalette, fontSize } = useTheme();
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <View style={{ gap: 14 }}>
      {data.map((d, i) => {
        const w = Math.max(4, (d.count / max) * 100);
        return (
          <View key={d.label} testID={`bar-${d.label}`}>
            <View style={styles.barHeader}>
              <Text numberOfLines={1} style={[styles.barLabel, { color: colors.onSurfaceSecondary, fontSize: fontSize.sm }]}>
                {d.label}
              </Text>
              <Text style={[styles.barCount, { color: colors.onSurface, fontSize: fontSize.sm }]}>
                {d.count}
              </Text>
            </View>
            <View style={[styles.barTrack, { backgroundColor: colors.surfaceTertiary }]}>
              <View
                style={{
                  width: `${w}%`,
                  height: "100%",
                  backgroundColor: chartPalette[i % chartPalette.length],
                  borderRadius: 2,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  donutRow: { flexDirection: "row", alignItems: "center", gap: 18 },
  donutCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  legend: { flex: 1, gap: 9 },
  legendRow: { flexDirection: "row", alignItems: "center" },
  swatch: { width: 10, height: 10, borderRadius: 2, marginRight: 8 },
  legendLabel: { flex: 1, fontSize: 12, letterSpacing: 0.2 },
  legendVal: { fontSize: 12, fontWeight: "700", marginLeft: 6 },
  barHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  barLabel: { flex: 1, letterSpacing: 0.2 },
  barCount: { fontWeight: "700", marginLeft: 8 },
  barTrack: { height: 8, borderRadius: 2, overflow: "hidden" },
});
