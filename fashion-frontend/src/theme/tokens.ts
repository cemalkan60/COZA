export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
} as const;

export const radius = {
  sm: 2,
  md: 4,
  lg: 8,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 34,
} as const;

export type ThemeColors = {
  surface: string;
  onSurface: string;
  surfaceSecondary: string;
  onSurfaceSecondary: string;
  surfaceTertiary: string;
  onSurfaceTertiary: string;
  surfaceInverse: string;
  onSurfaceInverse: string;
  brand: string;
  onBrand: string;
  brandSecondary: string;
  brandTertiary: string;
  onBrandTertiary: string;
  success: string;
  error: string;
  onError: string;
  border: string;
  borderStrong: string;
  divider: string;
};

export const darkColors: ThemeColors = {
  surface: "#101010",
  onSurface: "#F7F7F7",
  surfaceSecondary: "#1A1A1A",
  onSurfaceSecondary: "#EAEAEA",
  surfaceTertiary: "#262626",
  onSurfaceTertiary: "#D4D4D4",
  surfaceInverse: "#FAFAFA",
  onSurfaceInverse: "#101010",
  brand: "#D9D2C5",
  onBrand: "#101010",
  brandSecondary: "#968F83",
  brandTertiary: "#33312E",
  onBrandTertiary: "#D9D2C5",
  success: "#7FB894",
  error: "#E5989B",
  onError: "#FBEAEB",
  border: "#2E2E2E",
  borderStrong: "#4A4A4A",
  divider: "#212121",
};

export const lightColors: ThemeColors = {
  surface: "#FAFAFA",
  onSurface: "#101010",
  surfaceSecondary: "#F2F2F2",
  onSurfaceSecondary: "#1A1A1A",
  surfaceTertiary: "#E6E6E6",
  onSurfaceTertiary: "#333333",
  surfaceInverse: "#101010",
  onSurfaceInverse: "#FAFAFA",
  brand: "#101010",
  onBrand: "#FAFAFA",
  brandSecondary: "#595959",
  brandTertiary: "#EBEBEB",
  onBrandTertiary: "#101010",
  success: "#2E7D50",
  error: "#B3261E",
  onError: "#FBEAEB",
  border: "#E0E0E0",
  borderStrong: "#BDBDBD",
  divider: "#EEEEEE",
};

// Monotone chart palette (variations of brand / neutral) — luxe, not colorful.
export const chartPaletteDark = [
  "#D9D2C5",
  "#B8B0A2",
  "#968F83",
  "#7C766C",
  "#635E56",
  "#4E4A44",
  "#3D3A35",
  "#5C5347",
  "#8A8074",
  "#A79E90",
];

export const chartPaletteLight = [
  "#101010",
  "#2E2E2E",
  "#4A4A4A",
  "#635E56",
  "#7C766C",
  "#968F83",
  "#A79E90",
  "#B8B0A2",
  "#C9C1B3",
  "#D9D2C5",
];
