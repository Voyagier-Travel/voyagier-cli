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
 * The cabin and brand per flight for a flight fare, in the server's words:
 * `fareByFlight` verbatim when the row carries it ("DXB→DOH Economy, Main
 * Cabin · DOH→SIN Economy, Basic Economy"). When it is absent the server's
 * `legs` (on the row, or inside its `fare` block) are listed one flight per
 * entry with the cabin and brand values exactly as sent. Null when the row
 * carries neither: the server said nothing about the cabin, so nothing is
 * printed — `cabinClass` (the pricing slot) and the deprecated `bookedCabin`
 * are never read in its place.
 */
function fareByFlight(rec: Rec): string | null {
  const verbatim = str(rec.fareByFlight);
  if (verbatim) return verbatim;
  const fare = isRec(rec.fare) ? rec.fare : null;
  const legs = arr(Array.isArray(rec.legs) ? rec.legs : fare?.legs).filter(isRec);
  if (!legs.some((leg) => str(leg.cabin) || str(leg.brand))) return null;
  return legs
    .map((leg) => {
      const route = [str(leg.origin), str(leg.destination)].filter(Boolean).join("→");
      const conditions = [str(leg.cabin), str(leg.brand)].filter(Boolean).join(", ");
      return [route, conditions].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join(" · ");
}

/** The fare's brand as the server sent it (row-level, else the `fare` block's). */
function fareBrand(rec: Rec): string | null {
  const fare = isRec(rec.fare) ? rec.fare : null;
  return str(rec.brand) ?? (fare ? str(fare.brand) : null);
}

/**
 * The fare conditions a flight row carries for the fare its price buys:
 * cabin and brand per flight, brand, refundable / changeable, baggage, fare
 * basis codes, base fare and taxes. Every field is optional; a row with none of them renders nothing.
 * Null `baggage.checked` is "unknown", not "no bags", so it is left out.
 */
function renderFareConditions(opt: Rec): string {
  const bits: string[] = [];
  const perFlight = fareByFlight(opt);
  if (perFlight) bits.push(perFlight);
  const brand = fareBrand(opt);
  if (brand) bits.push(`brand ${brand}`);
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
 * The pricing facts a digest declares once, in the server's values: the
 * price tier and fetch time (`fetchStatus.priceTier` / `fetchedAt`), the
 * search record's `expiresAt`, and `optionsSummary.pricingNote` — the one
 * sentence the server wrote to relay with any price. Only fields the payload
 * carries are printed.
 */
function renderPricingLines(payload: Rec, summary: Rec | null): string[] {
  const lines: string[] = [];
  const fetchStatus = isRec(payload.fetchStatus) ? payload.fetchStatus : null;
  const bits: string[] = [];
  const priceTier = fetchStatus ? str(fetchStatus.priceTier) : null;
  if (priceTier) bits.push(`price tier ${priceTier}`);
  const fetchedAt = fetchStatus ? str(fetchStatus.fetchedAt) : null;
  if (fetchedAt) bits.push(`fetched ${fetchedAt}`);
  const expiresAt = str(payload.expiresAt);
  if (expiresAt) bits.push(`expires ${expiresAt}`);
  if (bits.length) lines.push(chalk.dim(`  ${bits.join("  ·  ")}`));
  const pricingNote = summary ? str(summary.pricingNote) : null;
  if (pricingNote) lines.push(chalk.dim(`  ${pricingNote}`));
  return lines;
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
  lines.push(...renderPricingLines(payload, summary));
  const count = summary ? num(summary.optionCount) : null;
  if (summary && count != null) {
    // A zero count is stated as a count; what to do next is the server's
    // nextStep sentence in the footer, never a sentence written here.
    lines.push(count === 0 ? chalk.dim("  0 options") : "");
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
  lines.push(...renderPricingLines(payload, summary));
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
    if (num(summary.checkoutOnlyBlockerCount) != null) bits.push(`checkout-only ${summary.checkoutOnlyBlockerCount}`);
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
      // gate and leadProblem are the server's enum values, printed as sent.
      const gate = str(b.gate) ? chalk.dim(` (gate ${b.gate})`) : "";
      const unverified = b.unverified === true ? chalk.dim(" (unverified)") : "";
      lines.push(`    ${chalk.red("•")} ${str(b.kind) ?? ""}${gate}${unverified}: ${str(b.message) ?? ""}`);
      const refs = isRec(b.refs) ? b.refs : {};
      const refBits = Object.entries(refs)
        .filter(([, v]) => str(v) || v === true)
        .map(([k, v]) => (v === true ? k : `${k} ${v}`));
      if (str(b.leadProblem)) refBits.push(`leadProblem ${b.leadProblem}`);
      const candidates = arr(b.candidateSelectionIds).map(String).filter(Boolean);
      if (candidates.length) refBits.push(`candidateSelectionIds ${candidates.join(",")}`);
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
      const refBits = ["goalId", "itemId", "selectionId", "participantChoiceId", "inputName", "airportRole"]
        .filter((k) => str(a[k]))
        .map((k) => `${k} ${a[k]}`);
      const travellerIds = arr(a.travellerIds).map(String).filter(Boolean);
      if (travellerIds.length) refBits.push(`travellerIds ${travellerIds.join(",")}`);
      const refs = refBits.join("  ");
      const gate = str(a.gate) ? chalk.dim(` (gate ${a.gate})`) : "";
      lines.push(`    ${chalk.cyan("→")} ${str(a.action) ?? ""}${gate}${str(a.detail) ? `: ${a.detail}` : ""}${refs ? chalk.dim(`  (${refs})`) : ""}`);
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
    lines.push(chalk.dim("  0 events"));
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
  const estimate = isRec(payload.estimate) ? payload.estimate : null;
  const estimateCurrency = estimate ? str(estimate.currency) : null;
  const items = arr(payload.items).filter(isRec);
  if (!items.length) lines.push(chalk.dim("  0 items"));
  for (const it of items) {
    const bookable = it.bookable === true ? chalk.green("bookable") : chalk.yellow(`not bookable${str(it.bookableReason) ? `: ${it.bookableReason}` : ""}`);
    const p = num(it.priceCents) != null ? priceCents(it.priceCents, it.currency) : price(it.price, it.currency);
    lines.push(`  • ${str(it.name) ?? "item"}  ${chalk.green(p)}  ${bookable}`);
    // Flight lines: the cabin and brand on each flight in the server's words
    // (fareByFlight), then the line's conditions — brand, price tier and
    // fetch time, refundable, checked bags — each printed only when sent.
    const perFlight = fareByFlight(it);
    if (perFlight) lines.push(chalk.dim(`      ${perFlight}`));
    const conditions: string[] = [];
    const brand = fareBrand(it);
    if (brand) conditions.push(`brand ${brand}`);
    const priceTier = str(it.priceTier);
    if (priceTier) conditions.push(`price tier ${priceTier}`);
    const fetchedAt = str(it.fetchedAt);
    if (fetchedAt) conditions.push(`fetched ${fetchedAt}`);
    const refundable = bool(it.refundable);
    if (refundable != null) conditions.push(refundable ? "refundable" : "non-refundable");
    const checkedBags = str(it.checkedBags);
    if (checkedBags) conditions.push(`checked bags ${checkedBags}`);
    if (conditions.length) lines.push(chalk.dim(`      ${conditions.join("  ·  ")}`));
    // display_currency estimate: display only, never the charge.
    const lineEstimate = price(it.estimatedTotal, estimateCurrency);
    if (lineEstimate) lines.push(chalk.dim(`      estimate ${lineEstimate}`));
    if (str(it.selectionId)) lines.push(chalk.dim(`      selection_id ${it.selectionId}${str(it.optionId) ? `  option_id ${it.optionId}` : ""}`));
  }
  const total = priceCents(payload.chargeableTotalCents, payload.currency);
  if (total) lines.push("", `  chargeable total ${chalk.bold.green(total)}${num(payload.chargeableTotalCents) != null ? chalk.dim(`  (${payload.chargeableTotalCents} cents)`) : ""}`);
  const totalEstimate = price(payload.estimatedTotal, estimateCurrency);
  if (totalEstimate) lines.push(chalk.dim(`  estimate ${totalEstimate}${estimate && str(estimate.asOf) ? `  (rate as of ${estimate.asOf})` : ""}`));
  const pricingNote = str(payload.pricingNote);
  if (pricingNote) lines.push(chalk.dim(`  ${pricingNote}`));
  const blockers = arr(payload.checkoutBlockers).filter(isRec);
  if (blockers.length) {
    lines.push("", chalk.bold("  Checkout blockers"));
    for (const b of blockers) {
      lines.push(`    ${chalk.red("•")} ${str(b.kind) ?? ""}${str(b.label) ? `: ${b.label}` : ""}`);
      const missing = arr(b.missingTravellerIds).map(String).filter(Boolean);
      if (missing.length) lines.push(chalk.dim(`        traveller_ids ${missing.join(", ")}`));
    }
  }
  const acceptance = isRec(payload.acceptance) ? payload.acceptance : null;
  if (acceptance && num(acceptance.expectTotalCents) != null) {
    const ids = arr(acceptance.itemIds).map(String);
    const planId = str(payload.tripPlanId) ?? str(payload.planId);
    lines.push(
      "",
      `  acceptance → voyagier book_plan --plan_id ${planId ? shellQuote(planId) : "<plan_id>"} --expect_total_cents ${acceptance.expectTotalCents}${ids.length ? ` --item_ids ${ids.map(shellQuote).join(" ")}` : ""}`,
    );
  } else if (str(payload.acceptanceUnavailableReason)) {
    lines.push("", chalk.yellow(`  acceptance unavailable: ${payload.acceptanceUnavailableReason}`));
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
