import React, { forwardRef, useMemo, useState, useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from "@gorhom/bottom-sheet";
import { Feather } from "@expo/vector-icons";

import { useTheme } from "@/src/theme/ThemeContext";

export type Filters = {
  origin?: string;
  supplier?: string;
  sort: string;
  price?: string; // preset key
};

const SORTS = [
  { key: "featured", label: "Öne çıkanlar" },
  { key: "price_asc", label: "Fiyat ↑" },
  { key: "price_desc", label: "Fiyat ↓" },
  { key: "name", label: "İsim A-Z" },
];

export const PRICE_RANGES: Record<string, { min?: number; max?: number; label: string }> = {
  all: { label: "Tümü" },
  r1: { max: 1000, label: "0 – 1.000" },
  r2: { min: 1000, max: 2500, label: "1.000 – 2.500" },
  r3: { min: 2500, max: 5000, label: "2.500 – 5.000" },
  r4: { min: 5000, label: "5.000+" },
};

type Props = {
  origins: string[];
  initial: Filters;
  onApply: (f: Filters) => void;
};

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: active ? colors.brand : colors.border,
          backgroundColor: active ? colors.brand : "transparent",
        },
      ]}
    >
      <Text
        style={{
          color: active ? colors.onBrand : colors.onSurfaceSecondary,
          fontSize: 13,
          fontWeight: active ? "700" : "500",
          letterSpacing: 0.2,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SectionTitle({ children }: React.PropsWithChildren) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.sectionTitle, { color: colors.brandSecondary }]}>
      {children}
    </Text>
  );
}

export const FilterSheet = forwardRef<BottomSheetModal, Props>(
  ({ origins, initial, onApply }, ref) => {
    const { colors, spacing } = useTheme();
    const snapPoints = useMemo(() => ["80%"], []);
    const [draft, setDraft] = useState<Filters>(initial);

    useEffect(() => {
      setDraft(initial);
    }, [initial]);

    const set = (patch: Partial<Filters>) => setDraft((d) => ({ ...d, ...patch }));

    const clear = () =>
      setDraft({ origin: undefined, supplier: undefined, sort: "featured", price: "all" });

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={snapPoints}
        enablePanDownToClose
        backgroundStyle={{ backgroundColor: colors.surface }}
        handleIndicatorStyle={{ backgroundColor: colors.borderStrong }}
        backdropComponent={(props) => (
          <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} />
        )}
      >
        <BottomSheetScrollView
          contentContainerStyle={{ padding: spacing.xl, paddingBottom: 140 }}
        >
          <Text style={[styles.title, { color: colors.onSurface }]}>Filtrele & Sırala</Text>

          <SectionTitle>SIRALAMA</SectionTitle>
          <View style={styles.wrap}>
            {SORTS.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                active={draft.sort === s.key}
                onPress={() => set({ sort: s.key })}
              />
            ))}
          </View>

          <SectionTitle>ÜRETİM YERİ</SectionTitle>
          <View style={styles.wrap}>
            <Chip label="Tümü" active={!draft.origin} onPress={() => set({ origin: undefined })} />
            {origins.map((o) => (
              <Chip
                key={o}
                label={o}
                active={draft.origin === o}
                onPress={() => set({ origin: draft.origin === o ? undefined : o })}
              />
            ))}
          </View>

          <SectionTitle>FİYAT ARALIĞI (TL)</SectionTitle>
          <View style={styles.wrap}>
            {Object.entries(PRICE_RANGES).map(([key, r]) => (
              <Chip
                key={key}
                label={r.label}
                active={(draft.price ?? "all") === key}
                onPress={() => set({ price: key })}
              />
            ))}
          </View>

          <SectionTitle>TEDARİKÇİ / STİL KODU</SectionTitle>
          <BottomSheetTextInput
            testID="filter-supplier-input"
            placeholder="örn. TR-698 veya 8003"
            placeholderTextColor={colors.brandSecondary}
            autoCapitalize="characters"
            defaultValue={draft.supplier}
            onChangeText={(t) => set({ supplier: t })}
            style={[
              styles.input,
              { color: colors.onSurface, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
            ]}
          />
        </BottomSheetScrollView>

        <View style={[styles.footer, { backgroundColor: colors.surface, borderTopColor: colors.divider }]}>
          <Pressable testID="filter-clear" onPress={clear} style={styles.clearBtn}>
            <Feather name="rotate-ccw" size={16} color={colors.onSurfaceSecondary} />
            <Text style={{ color: colors.onSurfaceSecondary, fontWeight: "600", marginLeft: 6 }}>
              Temizle
            </Text>
          </Pressable>
          <Pressable
            testID="filter-apply"
            onPress={() => onApply(draft)}
            style={[styles.applyBtn, { backgroundColor: colors.brand }]}
          >
            <Text style={{ color: colors.onBrand, fontWeight: "800", letterSpacing: 0.4 }}>
              Sonuçları Göster
            </Text>
          </Pressable>
        </View>
      </BottomSheetModal>
    );
  },
);

FilterSheet.displayName = "FilterSheet";

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: "800", letterSpacing: -0.3, marginBottom: 8 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 1.4, marginTop: 24, marginBottom: 12 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 14,
    fontSize: 15,
    letterSpacing: 0.5,
  },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 30,
    borderTopWidth: 1,
  },
  clearBtn: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 8 },
  applyBtn: { flex: 1, height: 52, borderRadius: 4, alignItems: "center", justifyContent: "center" },
});
