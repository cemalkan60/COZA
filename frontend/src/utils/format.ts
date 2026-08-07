export function formatPrice(value: number, currency = "TL"): string {
  const n = Math.round((value + Number.EPSILON) * 100) / 100;
  const [intPart, decPart = "00"] = n.toFixed(2).split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withSep},${decPart} ${currency}`;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${day}.${month}.${year} ${h}:${m}`;
  } catch {
    return "—";
  }
}
