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
 */
export function hintFlightSelected(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}This reserves your itinerary. Seat selection and cabin upgrades\n` +
    `     can be done directly with the airline after booking is confirmed.`
  );
}

/**
 * After selecting a hotel.
 */
export function hintHotelSelected(): string {
  return HINT_STYLE(
    `${HINT_PREFIX}Room preferences (bed type, floor, view) can usually be requested\n` +
    `     with the hotel after booking. Special requests aren't guaranteed.`
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
