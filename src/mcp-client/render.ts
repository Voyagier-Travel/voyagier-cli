/**
 * Thin human renderers for the handful of tools people read at a terminal.
 * Everything else prints pretty JSON. Renderers are driven by the payload
 * shape the server returns today (a `{ <operation>: {...} }` object per text
 * block); once the server publishes `structuredContent`/`outputSchema` they
 * switch to that without changing the command surface.
 *
 * Every renderer receives data that has already been through
 * `sanitizeExternalData` — supplier strings are display text, never
 * interpreted. Renderers must never throw on a shape they do not recognize:
 * they return null and the caller falls back to JSON.
 */
import chalk from "chalk";
import { formatPrice } from "../format.js";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * The server wraps each result as `{ <graphqlOperation>: payload }`. Unwrap
 * that single root key so renderers see the payload itself; anything else is
 * returned untouched.
 */
export function unwrapToolPayload(parsed: unknown): unknown {
  if (!isRec(parsed)) return parsed;
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return parsed;
  const inner = parsed[keys[0]];
  return inner !== null && typeof inner === "object" ? inner : parsed;
}

function price(p: unknown, currency?: unknown): string {
  const n = num(p);
  if (n === null) return "";
  const c = str(currency);
  return c && c !== "USD" ? `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}` : formatPrice(n);
}

function priceCents(p: unknown, currency?: unknown): string {
  const n = num(p);
  if (n === null) return "";
  return price(n / 100, currency);
}

function hhmm(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  const m = /T(\d{2}:\d{2})/.exec(s);
  return m ? m[1] : s;
}

// ── options digest (search_*, search_status, promote_search, get_selection_options)

function renderTopOptions(summary: Rec): string[] {
  const lines: string[] = [];
  const options = arr(summary.topOptions).filter(isRec);
  const callouts = isRec(summary.callouts) ? summary.callouts : {};
  const tag = (i: number): string => {
    const tags: string[] = [];
    if (num(callouts.cheapestIndex) === i) tags.push("cheapest");
    if (num(callouts.fastestIndex) === i) tags.push("fastest");
    if (num(callouts.earliestIndex) === i) tags.push("earliest");
    if (num(callouts.highestRatedIndex) === i) tags.push("top rated");
    return tags.length ? chalk.magenta(`[${tags.join(", ")}]`) : "";
  };
  for (const opt of options) {
    const index = num(opt.index) ?? options.indexOf(opt);
    const idx = chalk.bold.cyan(`[${index}]`);
    const segments = arr(opt.segments).filter(isRec);
    const parts: string[] = [];
    if (segments.length) {
      // Flight: one entry per direction.
      const airlines = arr(opt.airlines).map(String).join("/");
      if (airlines) parts.push(chalk.white(airlines));
      for (const seg of segments) {
        const route = `${str(seg.origin) ?? "?"}→${str(seg.destination) ?? "?"}`;
        const times = [hhmm(seg.departureTime), hhmm(seg.arrivalTime)].filter(Boolean).join("–");
        const stops = num(seg.stops);
        const stopLabel = stops === 0 ? "nonstop" : stops != null ? `${stops} stop${stops === 1 ? "" : "s"}` : "";
        parts.push([route, times, str(seg.durationLabel), stopLabel].filter(Boolean).join(" "));
      }
    } else {
      const name = str(opt.name);
      if (name) parts.push(chalk.white(name));
      const rating = num(opt.rating);
      if (rating != null) parts.push(chalk.yellow(`⭐${rating}`));
      const amenities = arr(opt.amenities).map(String);
      if (amenities.length) parts.push(chalk.dim(amenities.slice(0, 4).join(", ")));
      const duration = str(opt.durationLabel);
      if (duration) parts.push(chalk.dim(duration));
    }
    const p = price(opt.price, opt.currency);
    if (p) parts.push(chalk.green(p));
    if (opt.isBookable === false) parts.push(chalk.dim("not bookable"));
    const t = tag(index);
    if (t) parts.push(t);
    lines.push(`  ${idx}  ${parts.join("  ·  ")}`);
    const optionId = str(opt.optionId);
    if (optionId) lines.push(chalk.dim(`       option_id ${optionId}`));
  }
  const count = num(summary.optionCount);
  if (count != null && count > options.length) {
    lines.push(chalk.dim(`  … ${count - options.length} more (showing top ${options.length})`));
  }
  return lines;
}

/** search_flights / search_hotels / search_activities / search_status / promote_search */
export function renderSearchResult(payload: unknown): string | null {
  if (!isRec(payload)) return null;
  const summary = isRec(payload.optionsSummary) ? payload.optionsSummary : null;
  const status = str(payload.status) ?? (isRec(payload.fetchStatus) ? str(payload.fetchStatus.status) : null);
  if (!summary && !status) return null;
  const lines: string[] = [];
  const head: string[] = [];
  if (str(payload.type)) head.push(chalk.bold(String(payload.type)));
  if (status) head.push(`status ${statusColor(status)}`);
  if (str(payload.id)) head.push(chalk.dim(`id ${String(payload.id)}`));
  if (head.length) lines.push(head.join("  ·  "));
  const fetchError = str(payload.fetchError);
  if (fetchError) lines.push(chalk.red(`  ${fetchError}`));
  const count = summary ? num(summary.optionCount) : null;
  if (summary && count != null) {
    lines.push(count === 0 ? chalk.dim("  0 options yet — if status is Fetching, poll search_status / get_selection_options") : "");
    lines.push(...renderTopOptions(summary));
  }
  return lines.filter((l) => l !== "").join("\n");
}

/** get_selection_options */
export function renderSelectionOptions(payload: unknown): string | null {
  if (!isRec(payload)) return null;
  const fetchStatus = isRec(payload.fetchStatus) ? payload.fetchStatus : null;
  const summary = isRec(payload.optionsSummary) ? payload.optionsSummary : null;
  if (!fetchStatus && !summary) return null;
  const lines: string[] = [];
  const head: string[] = [];
  if (str(payload.__typename)) head.push(chalk.bold(String(payload.__typename).replace(/^TripPlan/, "")));
  const status = fetchStatus ? str(fetchStatus.status) : null;
  if (status) head.push(`status ${statusColor(status)}`);
  if (str(payload.id)) head.push(chalk.dim(`selection_id ${String(payload.id)}`));
  lines.push(head.join("  ·  "));
  if (fetchStatus) {
    const err = str(fetchStatus.fetchError);
    if (err) lines.push(chalk.red(`  ${err}`));
    const blocked = str(fetchStatus.blockedReason);
    if (blocked) lines.push(chalk.yellow(`  awaiting input: ${blocked}`));
    const q = isRec(fetchStatus.searchedQuery) ? fetchStatus.searchedQuery : null;
    if (q?.summary) lines.push(chalk.dim(`  searched: ${String(q.summary)}`));
    if (q?.degenerateHint) lines.push(chalk.yellow(`  hint: ${String(q.degenerateHint)}`));
  }
  if (summary) lines.push(...renderTopOptions(summary));
  return lines.join("\n");
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (/ready|booked/.test(s)) return chalk.green(status);
  if (/fetching|progress|pending/.test(s)) return chalk.cyan(status);
  if (/error|blocked|expired|fail/.test(s)) return chalk.red(status);
  if (/noresults|no_results|awaiting/.test(s)) return chalk.yellow(status);
  return status;
}

// ── plan_status

export function renderPlanStatus(payload: unknown): string | null {
  if (!isRec(payload) || !str(payload.readiness)) return null;
  const lines: string[] = [];
  const title = str(payload.title);
  lines.push(`${chalk.bold(title ?? "Plan")}  ·  readiness ${statusColor(String(payload.readiness))}`);
  if (str(payload.tripPlanId)) lines.push(chalk.dim(`  plan_id ${String(payload.tripPlanId)}`));

  const summary = isRec(payload.summary) ? payload.summary : null;
  if (summary) {
    const bits: string[] = [];
    if (num(summary.goalsDecided) != null && num(summary.goalsTotal) != null) {
      bits.push(`goals decided ${summary.goalsDecided}/${summary.goalsTotal}`);
    }
    if (num(summary.goalsBooked) != null) bits.push(`booked ${summary.goalsBooked}`);
    if (num(summary.blockerCount) != null) bits.push(`blockers ${summary.blockerCount}`);
    if (summary.bookableNow === true) bits.push(chalk.green("bookable now"));
    if (bits.length) lines.push(`  ${bits.join("  ·  ")}`);
  }

  const cart = isRec(payload.cart) ? payload.cart : null;
  if (cart) {
    const total = price(cart.total, cart.currency);
    lines.push(
      `  cart: ${num(cart.itemCount) ?? 0} item(s), ${num(cart.bookableCount) ?? 0} bookable${total ? `, total ${chalk.green(total)}` : ""}`,
    );
  }

  const goals = arr(payload.goals).filter(isRec);
  if (goals.length) {
    lines.push("", chalk.bold("  Goals"));
    for (const g of goals) {
      const state = g.isBooked ? chalk.green("booked") : g.isDecided ? chalk.green("decided") : g.isReady ? chalk.cyan("ready") : chalk.yellow("open");
      lines.push(`    ${state.padEnd(18)} ${str(g.name) ?? str(g.type) ?? ""} ${chalk.dim(str(g.type) ? `(${g.type})` : "")} ${chalk.dim(str(g.goalId) ? `goal_id ${g.goalId}` : "")}`.trimEnd());
    }
  }

  const blockers = arr(payload.blockers).filter(isRec);
  if (blockers.length) {
    lines.push("", chalk.bold("  Blockers"));
    for (const b of blockers) {
      const unverified = b.unverified === true ? chalk.dim(" (unverified)") : "";
      lines.push(`    ${chalk.red("•")} ${str(b.kind) ?? ""}${unverified}: ${str(b.message) ?? ""}`);
      const refs = isRec(b.refs) ? b.refs : {};
      const refBits = Object.entries(refs)
        .filter(([, v]) => str(v))
        .map(([k, v]) => `${k} ${v}`);
      if (refBits.length) lines.push(chalk.dim(`        ${refBits.join("  ")}`));
    }
  }

  const waiting = arr(payload.waiting).filter(isRec);
  if (waiting.length) {
    lines.push("", chalk.bold("  Waiting on the system"));
    for (const w of waiting) lines.push(`    ${chalk.cyan("◌")} ${str(w.kind) ?? ""}: ${str(w.message) ?? ""}`);
  }

  const travellers = arr(payload.travellers).filter(isRec);
  const missing = travellers.filter((t) => arr(t.missing).length > 0);
  if (missing.length) {
    lines.push("", chalk.bold("  Traveller data missing"));
    for (const t of missing) {
      lines.push(`    ${str(t.name) ?? str(t.travellerId) ?? "?"}: ${arr(t.missing).map(String).join(", ")} ${chalk.dim(str(t.travellerId) ? `traveller_id ${t.travellerId}` : "")}`.trimEnd());
    }
  }

  const next = arr(payload.nextActions).filter(isRec);
  if (next.length) {
    lines.push("", chalk.bold("  Next actions"));
    for (const a of next) {
      const refs = ["goalId", "selectionId", "inputName"]
        .filter((k) => str(a[k]))
        .map((k) => `${k} ${a[k]}`)
        .join("  ");
      lines.push(`    ${chalk.cyan("→")} ${str(a.action) ?? ""}${str(a.detail) ? `: ${a.detail}` : ""}${refs ? chalk.dim(`  (${refs})`) : ""}`);
    }
  }
  return lines.join("\n");
}

// ── itinerary

export function renderItinerary(payload: unknown): string | null {
  if (!isRec(payload)) return null;
  const events = arr(payload.tripPlanEvents ?? payload.events).filter(isRec);
  if (!Array.isArray(payload.tripPlanEvents ?? payload.events)) return null;
  const lines: string[] = [];
  const range = [str(payload.startDate), str(payload.endDate)].filter(Boolean).join(" → ");
  lines.push(`${chalk.bold(str(payload.title) ?? "Itinerary")}${range ? chalk.dim(`  ${range}`) : ""}`);
  if (!events.length) {
    lines.push(chalk.dim("  No events yet — select flights, hotels or activities first."));
    return lines.join("\n");
  }
  let lastDay = "";
  for (const ev of events) {
    // `datetime` is the ISO wall-clock instant (grouping key); `localTime` is
    // the server's display string ("11:00pm") when present.
    const iso = str(ev.datetime) ?? "";
    const day = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "";
    if (day && day !== lastDay) {
      lines.push("", chalk.bold(`  ${day}`));
      lastDay = day;
    }
    const time = str(ev.localTime) ?? hhmm(iso);
    const loc = isRec(ev.location) ? str(ev.location.name) : null;
    const who = arr(ev.travellers).filter(isRec).map((t) => str(t.name)).filter(Boolean);
    lines.push(
      `    ${chalk.cyan(time.padEnd(7))} ${str(ev.name) ?? ""}${loc ? chalk.dim(`  @ ${loc}`) : ""}${str(ev.duration) ? chalk.dim(`  ${ev.duration}`) : ""}${who.length ? chalk.dim(`  [${who.join(", ")}]`) : ""}${str(ev.bookingRecordId) ? chalk.green("  booked") : ""}`,
    );
  }
  return lines.join("\n");
}

// ── quote

export function renderQuote(payload: unknown): string | null {
  // The server prunes empty fields, so `items` is absent when nothing is carted.
  if (!isRec(payload) || !("chargeableTotalCents" in payload || "items" in payload || "checkoutBlockers" in payload)) return null;
  const lines: string[] = [chalk.bold("Quote")];
  const items = arr(payload.items).filter(isRec);
  if (!items.length) lines.push(chalk.dim("  No items in the cart yet."));
  for (const it of items) {
    const bookable = it.bookable === true ? chalk.green("bookable") : chalk.yellow(`not bookable${str(it.bookableReason) ? `: ${it.bookableReason}` : ""}`);
    const p = num(it.priceCents) != null ? priceCents(it.priceCents, it.currency) : price(it.price, it.currency);
    lines.push(`  • ${str(it.name) ?? "item"}  ${chalk.green(p)}  ${bookable}`);
    if (str(it.selectionId)) lines.push(chalk.dim(`      selection_id ${it.selectionId}${str(it.optionId) ? `  option_id ${it.optionId}` : ""}`));
  }
  const total = priceCents(payload.chargeableTotalCents, payload.currency);
  if (total) lines.push("", `  chargeable total ${chalk.bold.green(total)}${num(payload.chargeableTotalCents) != null ? chalk.dim(`  (${payload.chargeableTotalCents} cents)`) : ""}`);
  const blockers = arr(payload.checkoutBlockers).filter(isRec);
  if (blockers.length) {
    lines.push("", chalk.bold("  Checkout blockers"));
    for (const b of blockers) lines.push(`    ${chalk.red("•")} ${str(b.kind) ?? ""}${str(b.label) ? `: ${b.label}` : ""}`);
  }
  const acceptance = isRec(payload.acceptance) ? payload.acceptance : null;
  if (acceptance && num(acceptance.expectTotalCents) != null) {
    const ids = arr(acceptance.itemIds).map(String);
    const planId = str(payload.tripPlanId) ?? str(payload.planId);
    lines.push(
      "",
      chalk.bold("  To book at exactly this price:"),
      `    voyagier book --plan_id ${planId ?? "<plan_id>"} --expect_total_cents ${acceptance.expectTotalCents}${ids.length ? ` --item_ids ${ids.join(" ")}` : ""}`,
    );
  } else if (str(payload.acceptanceUnavailableReason)) {
    lines.push("", chalk.yellow(`  No gated booking possible: ${payload.acceptanceUnavailableReason}`));
  }
  return lines.join("\n");
}

// ── registry

export type ToolRenderer = (payload: unknown) => string | null;

/** Tool name → renderer. Tools not listed print JSON. */
export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  plan_status: renderPlanStatus,
  search_flights: renderSearchResult,
  search_hotels: renderSearchResult,
  search_activities: renderSearchResult,
  search_status: renderSearchResult,
  promote_search: renderSearchResult,
  get_selection_options: renderSelectionOptions,
  refresh_options: renderSelectionOptions,
  itinerary: renderItinerary,
  quote: renderQuote,
};

/**
 * Render a tool payload for a human. Returns null when no renderer applies or
 * the renderer does not recognize the shape (caller prints JSON).
 */
export function renderToolPayload(tool: string, parsed: unknown, planIdHint?: string): string | null {
  const renderer = TOOL_RENDERERS[tool];
  if (!renderer) return null;
  let payload = unwrapToolPayload(parsed);
  // quote's payload carries no plan id; thread the one the user passed so the
  // acceptance command is copy-pasteable.
  if (tool === "quote" && isRec(payload) && planIdHint) payload = { ...payload, tripPlanId: planIdHint };
  try {
    return renderer(payload);
  } catch {
    return null;
  }
}
