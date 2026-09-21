/**
 * Thin human renderers for the handful of tools people read at a terminal.
 * Everything else prints pretty JSON. Renderers are driven by the payload
 * shape the server returns today: each text block is the tool's bare result
 * object (the server strips the GraphQL operation key before it answers);
 * once the server publishes `structuredContent`/`outputSchema` they switch
 * to that without changing the command surface.
 *
 * Renderers are keyed by the server's verb-first tool names
 * (`get_plan_status`, `get_plan_quote`, …). The set is deliberately small;
 * tools not listed print JSON.
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

/** A GraphQL operation name: lower camelCase, letters only. */
const LEGACY_OPERATION_KEY = /^[a-z]+[A-Za-z]*$/;

/**
 * Legacy fallback. Servers before 2026-09-14 wrapped each result as
 * `{ <graphqlOperation>: payload }`; the current server returns the payload
 * itself. Unwrap only when the shape can be that legacy envelope: a single
 * root key that reads as a camelCase operation name (`tripPlanStatus`,
 * `myTripPlans`), whose value is an object or array, and which is not a field
 * the caller expects on the payload (`knownFields`). A real one-field payload
 * such as `{ items: [] }` or `{ readiness: "Ready" }` passes through untouched.
 */
export function unwrapToolPayload(parsed: unknown, knownFields: Iterable<string> = []): unknown {
  if (!isRec(parsed)) return parsed;
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return parsed;
  const key = keys[0];
  if (!LEGACY_OPERATION_KEY.test(key)) return parsed;
  for (const known of knownFields) if (known === key) return parsed;
  const inner = parsed[key];
  return inner !== null && typeof inner === "object" ? inner : parsed;
}

function price(p: unknown, currency?: unknown): string {
  const n = num(p);
  if (n === null) return "";
  const c = str(currency);
  return c && c !== "USD"
    ? `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`
    : formatPrice(n);
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

/**
 * Inputs of the invoking command that a renderer repeats in a copy-pasteable
 * follow-up line. The payload does not echo them, so the caller threads them
 * through: `planId` for `get_plan_quote`'s acceptance line, `query` and
 * `limit` for `get_options`' next-page line.
 */
export interface RenderHints {
  planId?: string;
  query?: string;
  limit?: number;
}

/** Characters that need no quoting in a POSIX shell word. */
const SHELL_BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value for a copy-pasteable shell line: bare when it is a plain
 * word, otherwise single-quoted with embedded single quotes closed, escaped
 * and reopened (`'\''`), which is safe for every character in sh/bash/zsh.
 */
export function shellQuote(value: string): string {
  if (value !== "" && SHELL_BARE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── options digest (search_*, get_search_status, promote_search, get_options)

/**
 * `queried` says the user passed a `query` to the command: then a digest whose
 * matchedCount equals optionCount is still a filtered one (every option
 * matched) and is worded as such.
 */
function renderTopOptions(summary: Rec, queried = false): string[] {
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
  const matched = num(summary.matchedCount);
  const shown = options.length;
  if (matched != null && count != null && (matched < count || (queried && matched === count))) {
    // A query filter narrowed the digest: the page is a slice of the matches,
    // not of all options, so the options beyond the matches are never "more".
    if (matched > shown) {
      lines.push(
        chalk.dim(`  … ${matched - shown} more (showing top ${shown} of ${matched} matching, ${count} total)`)
      );
    } else {
      lines.push(chalk.dim(`  (${matched} matching of ${count} total)`));
    }
  } else if (count != null && count > shown) {
    lines.push(chalk.dim(`  … ${count - shown} more (showing top ${shown})`));
  }
  return lines;
}

/**
 * The selection's decision rows (`participantChoices`): one line per row with
 * the `participant_choice_id` that `select_option` takes, the travellers it
 * covers, whether it is decided and the current option. Ends with a
 * copy-pasteable `select_option` for the first undecided row. Empty when the
 * payload carries no rows. Server field names: `id`, `decided`,
 * `travellerNames`, `locked`, `selectedOption { id, name }`.
 */
function renderParticipantChoices(payload: Rec): string[] {
  const rows = arr(payload.participantChoices).filter(isRec);
  if (!rows.length) return [];
  const lines: string[] = [chalk.dim("  rows:")];
  let firstUndecided: string | null = null;
  for (const row of rows) {
    const id = str(row.id);
    if (!id) continue;
    const parts: string[] = [chalk.cyan(`participant_choice_id ${id}`)];
    const names = arr(row.travellerNames).map(String).filter(Boolean);
    if (names.length) parts.push(chalk.white(names.join(", ")));
    const decided = row.decided === true;
    parts.push(decided ? chalk.green("decided") : chalk.yellow("undecided"));
    if (row.locked === true) parts.push(chalk.dim("locked"));
    const selected = isRec(row.selectedOption) ? row.selectedOption : null;
    const selectedName = selected ? str(selected.name) : null;
    if (selectedName) parts.push(`→ ${selectedName}`);
    lines.push(`    ${parts.join("  ·  ")}`);
    if (!decided && !firstUndecided) firstUndecided = id;
  }
  if (lines.length === 1) return [];
  if (firstUndecided) {
    // A server-provided id on a copy-pasteable line: the sanitizer strips
    // control characters, not shell metacharacters, so quote it too.
    lines.push(
      chalk.dim(
        `  decide a row: voyagier select_option --participant_choice_id ${shellQuote(firstUndecided)} --option_id <option_id>`
      )
    );
  }
  return lines;
}

/**
 * The next page of the options digest, when the server says there is one
 * (`optionsSummary.nextCursor`). The tool's contract is to send the cursor
 * back "with the same query", and the payload does not echo the inputs the
 * page was read with, so the line repeats the `--query` and `--limit` the
 * user passed (from `hints`), shell-quoted.
 */
function renderOptionsCursor(payload: Rec, summary: Rec, hints: RenderHints = {}): string[] {
  const cursor = str(summary.nextCursor);
  if (!cursor) return [];
  const selectionId = str(payload.id);
  const repeat = [
    typeof hints.query === "string" ? ` --query ${shellQuote(hints.query)}` : "",
    typeof hints.limit === "number" && Number.isFinite(hints.limit) ? ` --limit ${hints.limit}` : "",
  ].join("");
  return [
    chalk.dim(
      `  more options: voyagier get_options --selection_id ${selectionId ? shellQuote(selectionId) : "<selection_id>"} --cursor ${shellQuote(cursor)}${repeat}`
    ),
  ];
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
    lines.push(
      count === 0 ? chalk.dim("  0 options yet — if status is Fetching, poll get_search_status / get_options") : ""
    );
    lines.push(...renderTopOptions(summary));
  }
  return lines.filter(l => l !== "").join("\n");
}

/**
 * get_options. `hints` carries the invoking command's `query` and `limit`.
 * (`refresh_options` returns bare `true` and prints JSON like any other tool.)
 */
export function renderSelectionOptions(payload: unknown, hints: RenderHints = {}): string | null {
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
  if (summary) lines.push(...renderTopOptions(summary, typeof hints.query === "string"));
  lines.push(...renderParticipantChoices(payload));
  if (summary) lines.push(...renderOptionsCursor(payload, summary, hints));
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
      `  cart: ${num(cart.itemCount) ?? 0} item(s), ${num(cart.bookableCount) ?? 0} bookable${total ? `, total ${chalk.green(total)}` : ""}`
    );
  }

  const goals = arr(payload.goals).filter(isRec);
  if (goals.length) {
    lines.push("", chalk.bold("  Goals"));
    for (const g of goals) {
      const state = g.isBooked
        ? chalk.green("booked")
        : g.isDecided
          ? chalk.green("decided")
          : g.isReady
            ? chalk.cyan("ready")
            : chalk.yellow("open");
      lines.push(
        `    ${state.padEnd(18)} ${str(g.name) ?? str(g.type) ?? ""} ${chalk.dim(str(g.type) ? `(${g.type})` : "")} ${chalk.dim(str(g.goalId) ? `goal_id ${g.goalId}` : "")}`.trimEnd()
      );
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
  const missing = travellers.filter(t => arr(t.missing).length > 0);
  if (missing.length) {
    lines.push("", chalk.bold("  Traveller data missing"));
    for (const t of missing) {
      lines.push(
        `    ${str(t.name) ?? str(t.travellerId) ?? "?"}: ${arr(t.missing).map(String).join(", ")} ${chalk.dim(str(t.travellerId) ? `traveller_id ${t.travellerId}` : "")}`.trimEnd()
      );
    }
  }

  const next = arr(payload.nextActions).filter(isRec);
  if (next.length) {
    lines.push("", chalk.bold("  Next actions"));
    for (const a of next) {
      const refs = ["goalId", "selectionId", "inputName"]
        .filter(k => str(a[k]))
        .map(k => `${k} ${a[k]}`)
        .join("  ");
      lines.push(
        `    ${chalk.cyan("→")} ${str(a.action) ?? ""}${str(a.detail) ? `: ${a.detail}` : ""}${refs ? chalk.dim(`  (${refs})`) : ""}`
      );
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
    const who = arr(ev.travellers)
      .filter(isRec)
      .map(t => str(t.name))
      .filter(Boolean);
    lines.push(
      `    ${chalk.cyan(time.padEnd(7))} ${str(ev.name) ?? ""}${loc ? chalk.dim(`  @ ${loc}`) : ""}${str(ev.duration) ? chalk.dim(`  ${ev.duration}`) : ""}${who.length ? chalk.dim(`  [${who.join(", ")}]`) : ""}${str(ev.bookingRecordId) ? chalk.green("  booked") : ""}`
    );
  }
  return lines.join("\n");
}

// ── get_plan_quote

export function renderQuote(payload: unknown): string | null {
  // The server prunes empty fields, so `items` is absent when nothing is carted.
  if (!isRec(payload) || !("chargeableTotalCents" in payload || "items" in payload || "checkoutBlockers" in payload))
    return null;
  const lines: string[] = [chalk.bold("Quote")];
  const items = arr(payload.items).filter(isRec);
  if (!items.length) lines.push(chalk.dim("  No items in the cart yet."));
  for (const it of items) {
    const bookable =
      it.bookable === true
        ? chalk.green("bookable")
        : chalk.yellow(`not bookable${str(it.bookableReason) ? `: ${it.bookableReason}` : ""}`);
    const p = num(it.priceCents) != null ? priceCents(it.priceCents, it.currency) : price(it.price, it.currency);
    lines.push(`  • ${str(it.name) ?? "item"}  ${chalk.green(p)}  ${bookable}`);
    if (str(it.selectionId))
      lines.push(
        chalk.dim(`      selection_id ${it.selectionId}${str(it.optionId) ? `  option_id ${it.optionId}` : ""}`)
      );
  }
  const total = priceCents(payload.chargeableTotalCents, payload.currency);
  if (total)
    lines.push(
      "",
      `  chargeable total ${chalk.bold.green(total)}${num(payload.chargeableTotalCents) != null ? chalk.dim(`  (${payload.chargeableTotalCents} cents)`) : ""}`
    );
  const blockers = arr(payload.checkoutBlockers).filter(isRec);
  if (blockers.length) {
    lines.push("", chalk.bold("  Checkout blockers"));
    for (const b of blockers)
      lines.push(`    ${chalk.red("•")} ${str(b.kind) ?? ""}${str(b.label) ? `: ${b.label}` : ""}`);
  }
  const acceptance = isRec(payload.acceptance) ? payload.acceptance : null;
  if (acceptance && num(acceptance.expectTotalCents) != null) {
    const ids = arr(acceptance.itemIds).map(id => shellQuote(String(id)));
    const planId = str(payload.tripPlanId) ?? str(payload.planId);
    lines.push(
      "",
      chalk.bold("  To book at exactly this price:"),
      `    voyagier book_plan --plan_id ${planId ? shellQuote(planId) : "<plan_id>"} --expect_total_cents ${acceptance.expectTotalCents}${ids.length ? ` --item_ids ${ids.join(" ")}` : ""}`
    );
  } else if (str(payload.acceptanceUnavailableReason)) {
    lines.push("", chalk.yellow(`  No gated booking possible: ${payload.acceptanceUnavailableReason}`));
  }
  return lines.join("\n");
}

// ── registry

/** Renderers may ignore `hints`; those that print a follow-up command read the inputs they need from it. */
export type ToolRenderer = (payload: unknown, hints?: RenderHints) => string | null;

/**
 * Root payload fields each renderer reads. `unwrapToolPayload` uses them to
 * tell a genuine one-field payload from the legacy `{ <operation>: … }`
 * envelope.
 */
const RENDERER_FIELDS = {
  planStatus: [
    "readiness",
    "title",
    "tripPlanId",
    "summary",
    "cart",
    "goals",
    "blockers",
    "waiting",
    "travellers",
    "nextActions",
  ],
  searchResult: ["optionsSummary", "status", "fetchStatus", "type", "id", "fetchError"],
  selectionOptions: ["fetchStatus", "optionsSummary", "id", "participantChoices", "__typename"],
  itinerary: ["tripPlanEvents", "events", "startDate", "endDate", "title"],
  quote: [
    "chargeableTotalCents",
    "items",
    "checkoutBlockers",
    "currency",
    "acceptance",
    "tripPlanId",
    "planId",
    "acceptanceUnavailableReason",
  ],
} as const;

const TOOL_FIELDS: Record<string, readonly string[]> = {
  get_plan_status: RENDERER_FIELDS.planStatus,
  search_flights: RENDERER_FIELDS.searchResult,
  search_hotels: RENDERER_FIELDS.searchResult,
  search_activities: RENDERER_FIELDS.searchResult,
  get_search_status: RENDERER_FIELDS.searchResult,
  promote_search: RENDERER_FIELDS.searchResult,
  get_options: RENDERER_FIELDS.selectionOptions,
  get_plan_itinerary: RENDERER_FIELDS.itinerary,
  get_plan_quote: RENDERER_FIELDS.quote,
};

/** Tool name → renderer. Tools not listed print JSON. */
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
 * the renderer does not recognize the shape (caller prints JSON). `hints` are
 * the invoking command's inputs the renderers repeat (see `RenderHints`).
 */
export function renderToolPayload(tool: string, parsed: unknown, hints: RenderHints = {}): string | null {
  const renderer = TOOL_RENDERERS[tool];
  if (!renderer) return null;
  let payload = unwrapToolPayload(parsed, TOOL_FIELDS[tool] ?? []);
  // get_plan_quote's payload carries no plan id; thread the one the user
  // passed so the acceptance command is copy-pasteable.
  if (tool === "get_plan_quote" && isRec(payload) && hints.planId) payload = { ...payload, tripPlanId: hints.planId };
  try {
    return renderer(payload, hints);
  } catch {
    return null;
  }
}
