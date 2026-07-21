/**
 * Contextual explainers for travel booking concepts.
 * Shown at key moments in the CLI flow to help users understand
 * what they're buying and what happens next.
 */
import chalk from "chalk";

const HINT_STYLE = chalk.dim;
const HINT_PREFIX = "  💡 ";

/**
 * After selecting a flight (departure or return or one-way).
 *
 * VOY-1718: the fare/cabin CLASS is a decision made IN the CLI (the Fare &
 * Cabin step, defaults to Economy). Seat selection and cabin UPGRADES remain
 * airline-side after booking — the fare pick doesn't cover those (demmersong
 * 2026-07-21: keep that sentence).
 */
export function hintFlightSelected(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}This reserves the itinerary. Once every leg is picked (a\n` +
    `     one-way has just one), the Fare & Cabin (FlightClass) step is chosen\n` +
    `     here in the CLI (defaults to Economy) — run plan-status to surface it.\n` +
    `     Seat selection and cabin upgrades can be done directly with the\n` +
    `     airline after booking is confirmed.`
  );
}

/**
 * After selecting a hotel.
 *
 * VOY-1718: picking the hotel is the FIRST link in a chain — the room decision
 * comes next, and the baseline rate is then auto-selected for you.
 */
export function hintHotelSelected(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Picking the hotel spawns its room decision. Choose a room and\n` +
    `     the baseline rate is auto-selected — run plan-status (or select --wait)\n` +
    `     to see the next pick. Bed type / floor / view are requested with the\n` +
    `     hotel after booking; special requests aren't guaranteed.`
  );
}

/**
 * On the cart view, before checkout.
 */
export function hintCartCheckout(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Prices are held temporarily and may change if not booked soon.\n` +
    `     A processing fee will be added at checkout — it covers processing costs (credit card, booking, servicing).`
  );
}

/**
 * After checkout session is created (before Stripe payment).
 */
export function hintCheckoutCreated(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Your flights are held at this price while you complete payment.\n` +
    `     If the session expires, prices may change on the next attempt.`
  );
}

/**
 * After booking is confirmed (status view).
 */
export function hintBookingConfirmed(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Your PNR (Passenger Name Record) is your booking reference.\n` +
    `     Use it to check in, select seats, and manage your booking\n` +
    `     directly on the airline's website.`
  );
}

/**
 * When booking status shows pending.
 */
export function hintBookingPending(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Booking is being processed. Flight tickets are typically issued\n` +
    `     within minutes. Hotel confirmations may take up to 24 hours.`
  );
}

/**
 * When picking a cabin class sub-selection.
 */
export function hintCabinClass(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Cabin class determines your seat type and included services.\n` +
    `     You can still select a specific seat with the airline after booking.`
  );
}

/**
 * When picking a hotel room sub-selection.
 */
export function hintHotelRoom(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Room type sets the category (e.g., Deluxe, Suite). Specific room\n` +
    `     number and bed configuration are assigned by the hotel at check-in.`
  );
}

/**
 * On dry-run output.
 */
export function hintDryRun(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Prices shown are estimates. The final amount is confirmed\n` +
    `     at checkout when the fare is locked with the provider.`
  );
}
