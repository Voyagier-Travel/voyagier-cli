/**
 * Leaf formatting helpers — deliberately dependency-free so render modules can
 * import them without pulling in `utils`.
 */

/**
 * Format a price with commas and 2 decimal places.
 * e.g. 1234.5 → "$1,234.50"
 */
export function formatPrice(price: number): string {
  return "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
