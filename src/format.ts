/**
 * Leaf formatting/money helpers — deliberately dependency-free.
 *
 * `utils.ts` and `hotel-format.ts` both need these; keeping them in a leaf
 * module (instead of utils) avoids the utils ↔ hotel-format import cycle
 * (utils renders hotel stay labels; hotel-format renders prices).
 */

/**
 * Format a price with commas and 2 decimal places.
 * e.g. 1234.5 → "$1,234.50"
 */
export function formatPrice(price: number): string {
  return "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Dollars → integer cents, the ONE rounding used on money comparisons.
 * book's price gate and quote's offer total must share this function so a
 * quoted total can never disagree with the gate that later enforces it
 * (VOY-1706 self-consistency, extended cross-command by VOY-1212).
 */
export function cents(n: number): number {
  return Math.round(n * 100);
}

/**
 * Round a dollar amount to the nearest cent for JSON emission, via the same
 * integer-cents rounding `cents()` uses for comparisons. Kills float-sum
 * artifacts (e.g. 0.1 + 0.2 → 0.30000000000000004 → 0.3) without changing the
 * type: money fields stay numbers. (This is value rounding, not fixed-width
 * formatting — JSON serializes 10 as 10, not "10.00".) Use wherever a summed money value is written
 * to a machine surface (`cart`/`book` JSON) so emitted totals never leak the raw
 * float. Comparisons still go through `cents()` — this only cleans OUTPUT.
 */
export function money(n: number): number {
  return cents(n) / 100;
}
