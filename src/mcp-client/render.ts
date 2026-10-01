/**
 * Thin human renderers for the handful of tools people read at a terminal.
 * Everything else prints pretty JSON. Renderers read the payload the server
 * returns today: each text block is the tool's result object itself (bare, no
 * `{ <operation>: … }` wrapper, empty fields pruned); once the server
 * publishes `structuredContent`/`outputSchema` they switch to that without
 * changing the command surface.
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

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Characters that need no quoting in a POSIX shell word. */
const SHELL_BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value for a copy-pasteable shell line: bare when it is a plain
 * word, otherwise single-quoted with embedded single quotes escaped. Every
 * server-provided value interpolated into a `voyagier …` line goes through
 * this — sanitizeExternalData strips control characters, not shell syntax.
 */
export function shellQuote(value: string): string {
  if (value !== "" && SHELL_BARE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hhmm(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  const m = /T(\d{2}:\d{2})/.exec(s);
  return m ? m[1] : s;
}

// ── options digest (search_*, get_search_status, promote_search, get_options)

function renderTopOptions(summary: Rec, opts: { omitMoreLine?: boolean } = {}): string[] {
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
        const legs = renderLegs(seg.legs);
        parts.push([route, times, str(seg.durationLabel), stopLabel, legs ? chalk.dim(legs) : ""].filter(Boolean).join(" "));
      }
    } else {
      const name = str(opt.name);
      if (name) parts.push(chalk.white(name));
      const rating = num(opt.rating);
      if (rating != null) parts.push(chalk.yellow(`⭐${rating}`));
      // Hotel rows: miles from the searched point, as the server computed it.
      // Always one decimal so `2` and `1.2` line up as `2.0 mi` / `1.2 mi`.
      const distanceMi = num(opt.distanceMi);
      if (distanceMi != null) parts.push(chalk.dim(`${distanceMi.toFixed(1)} mi`));
      const amenities = arr(opt.amenities).map(String);
      if (amenities.length) parts.push(chalk.dim(amenities.slice(0, 4).join(", ")));
      const duration = str(opt.durationLabel);
      if (duration) parts.push(chalk.dim(duration));
    }
    const p = price(opt.price, opt.currency);
    if (p) parts.push(chalk.green(p));
    // Only rows that book as themselves (fare, room rate, activity option,
    // imported or custom item) carry bookable + bookableReason — the same pair
    // quote lines use. Every other row, and every search-result row, carries
    // no bookable key at all, so it gets no verdict of any kind.
    if (opt.bookable === true) parts.push(chalk.green("bookable"));
    else if (opt.bookable === false) {
      const reason = str(opt.bookableReason);
      parts.push(chalk.yellow(`not bookable${reason ? `: ${reason}` : ""}`));
    }
    const t = tag(index);
    if (t) parts.push(t);
    lines.push(`  ${idx}  ${parts.join("  ·  ")}`);
    const fare = renderFareConditions(opt);
    if (fare) lines.push(chalk.dim(`       ${fare}`));
    const optionId = str(opt.optionId);
    if (optionId) lines.push(chalk.dim(`       option_id ${optionId}`));
  }
  const count = num(summary.optionCount);
  if (!opts.omitMoreLine && count != null && count > options.length) {
    lines.push(chalk.dim(`  … ${count - options.length} more (showing top ${options.length})`));
  }
  return lines;
}

/**
 * One segment's legs as "EK 384 (op. FZ), EK 12" — marketing carrier + flight
 * number, with the operating carrier when it differs. Empty when the segment
 * carries no legs or no leg names a carrier.
 */
function renderLegs(legs: unknown): string {
  const out: string[] = [];
  for (const leg of arr(legs).filter(isRec)) {
    const marketing = str(leg.marketingCarrier);
    const operating = str(leg.operatingCarrier);
    const flightNumber = num(leg.flightNumber) ?? str(leg.flightNumber);
    const carrier = marketing ?? operating;
    if (!carrier) continue;
    const head = flightNumber != null ? `${carrier} ${flightNumber}` : carrier;
    out.push(marketing && operating && operating !== marketing ? `${head} (op. ${operating})` : head);
  }
  return out.join(", ");
}

/**
 * The cabin label for a fare: the cabin its fare basis codes actually book
 * (`bookedCabin`), falling back to the slot it was requested under
 * (`cabinClass`) when the server does not say. The two differ when a supplier
 * fills a cabin request with a fare from another cabin (a "premium-economy"
 * request filled with a business fare): the client flies the booked cabin, so
 * that is the label, and the requested slot follows in parentheses because it
 * is still the name the row was shopped under. A fare that books different
 * cabins on different segments says so. Fields are read from the row itself
 * and from its nested `fare` block (Fare & Cabin rows carry both). Null when
 * neither cabin is present.
 *
 * `bookedCabinRequired` is for quote lines: there the server always states the
 * booked cabin when it knows it, and a line with a requested slot but no
 * booked cabin means the cabin is unknown or mixed. The label says that
 * instead of falling back, because the quote is what gets relayed with the
 * total. Search rows keep the fallback: their `cabinClass` is the fare's own
 * cabin and most rows carry no booked cabin at all.
 */
function fareCabinLabel(rec: Rec, opts: { bookedCabinRequired?: boolean } = {}): string | null {
  const fare = isRec(rec.fare) ? rec.fare : null;
  const requested = str(rec.cabinClass) ?? (fare ? str(fare.cabinClass) : null);
  const booked = str(rec.bookedCabin) ?? (fare ? str(fare.bookedCabin) : null);
  const mixed = bool(rec.mixedCabin) ?? (fare ? bool(fare.mixedCabin) : null);
  if (!booked && !requested) return null;
  if (!booked && opts.bookedCabinRequired) {
    return `${mixed === true ? "mixed cabins" : "cabin unknown or mixed"} (requested ${requested})`;
  }
  const label = (booked ?? requested) as string;
  const notes: string[] = [];
  if (mixed === true) notes.push("mixed cabins");
  if (booked && requested && booked.toLowerCase() !== requested.toLowerCase()) notes.push(`requested ${requested}`);
  return notes.length ? `${label} (${notes.join("; ")})` : label;
}

/**
 * The fare conditions a flight row carries for the fare its price buys:
 * cabin, refundable / changeable, baggage, fare basis codes, base fare and
 * taxes. Every field is optional; a row with none of them renders nothing.
 * Null `baggage.checked` is "unknown", not "no bags", so it is left out.
 */
function renderFareConditions(opt: Rec): string {
  const bits: string[] = [];
  const cabin = fareCabinLabel(opt);
  if (cabin) bits.push(cabin);
  const refundable = bool(opt.refundable);
  if (refundable != null) bits.push(refundable ? "refundable" : "non-refundable");
  const changeable = bool(opt.changeable);
  if (changeable != null) bits.push(changeable ? "changeable" : "no changes");
  const baggage = isRec(opt.baggage) ? opt.baggage : null;
  if (baggage) {
    const bags: string[] = [];
    const carryOn = str(baggage.carryOn);
    if (carryOn) bags.push(`carry-on ${carryOn}`);
    const checked = str(baggage.checked);
    if (checked) bags.push(`checked ${checked}`);
    if (bags.length) bits.push(`bags: ${bags.join(", ")}`);
  }
  const fareBasis = arr(opt.fareBasis).map(String).filter((s) => s.trim());
  if (fareBasis.length) bits.push(`fare basis ${fareBasis.join("/")}`);
  const baseFare = price(opt.baseFare, opt.currency);
  const taxes = price(opt.taxes, opt.currency);
  if (baseFare && taxes) bits.push(`base ${baseFare} + taxes ${taxes}`);
  else if (baseFare) bits.push(`base fare ${baseFare}`);
  else if (taxes) bits.push(`taxes ${taxes}`);
  return bits.join("  ·  ");
}

/**
 * Footer under an options digest: how many rows matched of how many the
 * search holds, the carrier facet, why nothing matched, the next page as a
 * copy-pasteable command, and the server's nextStep / howToRefine sentences.
 * Only fields the payload carries are printed.
 */
function renderSearchFooter(payload: Rec, summary: Rec): string[] {
  const lines: string[] = [];
  const optionCount = num(summary.optionCount);
  const matchedCount = num(summary.matchedCount);
  if (matchedCount != null && optionCount != null && matchedCount !== optionCount) {
    lines.push(chalk.dim(`  ${matchedCount} of ${optionCount} options match the current filters`));
  }
  const noMatchReason = str(summary.noMatchReason);
  if (noMatchReason) lines.push(chalk.yellow(`  no match: ${noMatchReason}`));
  const facet = arr(summary.airlines)
    .filter(isRec)
    .map((f) => {
      const key = str(f.key) ?? str(f.code);
      const count = num(f.count);
      return key && count != null ? `${key} ${count}` : null;
    })
    .filter((s): s is string => s !== null);
  if (facet.length) lines.push(chalk.dim(`  airlines: ${facet.join("  ")}`));
  const nextCursor = str(summary.nextCursor);
  if (nextCursor) {
    // The cursor is opaque and the payload carries no offset, so the rows
    // left after THIS page are unknown on page 2+; say "more", not a number.
    // The command line is printed only when it is copy-pasteable: a bare
    // `<search_id>` placeholder would be read by the shell as a redirection.
    const searchId = str(payload.id) ?? str(payload.searchId);
    if (searchId) {
      lines.push(
        `  more → voyagier get_search_status --search_id ${shellQuote(searchId)} --cursor ${shellQuote(nextCursor)}${chalk.dim("  (repeat the same sort and filters)")}`,
      );
    } else {
      lines.push(chalk.dim("  more results available"));
    }
  }
  const nextStep = str(summary.nextStep);
  if (nextStep) lines.push(chalk.dim(`  next: ${nextStep}`));
  const howToRefine = str(summary.howToRefine);
  if (howToRefine) lines.push(chalk.dim(`  refine: ${howToRefine}`));
  return lines;
}

/** search_flights / search_hotels / search_activities / get_search_status / promote_search */
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
    lines.push(count === 0 ? chalk.dim("  0 options yet — if status is Fetching, poll get_search_status / get_options") : "");
    // A summary that carries matchedCount is server-paged: topOptions is one
    // page of an opaque-cursor list, so "N more" cannot be computed from the
    // rows on hand. The footer states the matched total and the next page.
    lines.push(...renderTopOptions(summary, { omitMoreLine: num(summary.matchedCount) != null || str(summary.nextCursor) !== null }));
  }
  if (summary) lines.push(...renderSearchFooter(payload, summary));
  return lines.filter((l) => l !== "").join("\n");
}

/** get_options */
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

// ── get_plan_status

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

// ── get_plan_itinerary

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

// ── get_plan_quote

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
    // Flight lines: the cabin the client flies, read before the total is
    // relayed. A line with no booked cabin is said to be unknown or mixed,
    // never relabelled with the requested slot.
    const cabin = fareCabinLabel(it, { bookedCabinRequired: true });
    if (cabin) lines.push(chalk.dim(`      ${cabin}`));
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
      `    voyagier book_plan --plan_id ${planId ?? "<plan_id>"} --expect_total_cents ${acceptance.expectTotalCents}${ids.length ? ` --item_ids ${ids.join(" ")}` : ""}`,
    );
  } else if (str(payload.acceptanceUnavailableReason)) {
    lines.push("", chalk.yellow(`  No gated booking possible: ${payload.acceptanceUnavailableReason}`));
  }
  return lines.join("\n");
}

// ── registry

export type ToolRenderer = (payload: unknown) => string | null;

/**
 * Tool name → renderer. Tools not listed print JSON (`refresh_options` is not
 * listed: it returns `true`).
 */
export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  get_plan_status: renderPlanStatus,
  search_flights: renderSearchResult,
  search_hotels: renderSearchResult,
  search_activities: renderSearchResult,
  get_search_status: renderSearchResult,
  promote_search: renderSearchResult,
  get_options: renderSelectionOptions,
  get_plan_itinerary: renderItinerary,
  get_plan_quote: renderQuote,
};

/**
 * Render a tool payload for a human. Returns null when no renderer applies or
 * the renderer does not recognize the shape (caller prints JSON). `parsed` is
 * the tool's text block as the server sent it; renderers read it directly.
 */
export function renderToolPayload(tool: string, parsed: unknown, planIdHint?: string): string | null {
  const renderer = TOOL_RENDERERS[tool];
  if (!renderer) return null;
  let payload = parsed;
  // get_plan_quote's payload carries no plan id; thread the one the user
  // passed so the acceptance command is copy-pasteable.
  if (tool === "get_plan_quote" && isRec(payload) && planIdHint) payload = { ...payload, tripPlanId: planIdHint };
  try {
    return renderer(payload);
  } catch {
    return null;
  }
}
