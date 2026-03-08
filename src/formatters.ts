import chalk from "chalk";

/**
 * Matches SlimFlightOption from nest-api's slim-option-mapper.ts:
 * { id, airline: { name, iata }, flightNumber, departure: { time, airport },
 *   arrival: { time, airport, nextDay }, stops, duration, price: { amount, currency } }
 */
interface SlimFlightOption {
  id?: string;
  airline?: { name?: string; iata?: string };
  flightNumber?: string;
  departure?: { time?: string; airport?: string };
  arrival?: { time?: string; airport?: string; nextDay?: boolean };
  stops?: string;
  duration?: string;
  price?: { amount?: number; currency?: string };
}

/**
 * Matches SlimHotelOption from nest-api's slim-option-mapper.ts:
 * { id, hotelCode, name, address, rating, reviewScore, price: { amount, currency }, imageUrl }
 */
interface SlimHotelOption {
  id?: string;
  hotelCode?: string;
  name?: string;
  address?: string;
  rating?: number;
  reviewScore?: number;
  price?: { amount?: number; currency?: string };
  imageUrl?: string;
}

export function formatFlights(flights: SlimFlightOption[]): string {
  if (!flights || flights.length === 0) return chalk.dim("  No flights found.");

  return flights
    .map((f, i) => {
      const depAirport = f.departure?.airport ?? "?";
      const arrAirport = f.arrival?.airport ?? "?";
      const route = `${depAirport} → ${arrAirport}`;

      const amt = f.price?.amount;
      const price = amt != null ? `$${amt.toLocaleString()}` : "Price N/A";
      const duration = f.duration ?? "?";
      const stops = f.stops ?? "?";
      const stopsFormatted = stops.toLowerCase().includes("non-stop") ? chalk.green(stops) : stops;

      const flightNum = f.flightNumber ?? "";
      const depTime = f.departure?.time ? `Departs ${f.departure.time}` : "";
      const nextDay = f.arrival?.nextDay ? chalk.yellow(" +1") : "";

      const details = [flightNum, depTime].filter(Boolean).join("  ·  ");
      const optionId = f.id ? chalk.dim(`Option ${i + 1}: ${f.id.slice(0, 8)}`) : chalk.dim(`Option ${i + 1}`);

      return [
        `  ✈️  ${chalk.bold(route)}  ·  ${chalk.yellow(price)}  ·  ${duration}  ·  ${stopsFormatted}${nextDay}`,
        details ? `     ${chalk.dim(details)}` : null,
        `     ${optionId}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function formatHotels(hotels: SlimHotelOption[]): string {
  if (!hotels || hotels.length === 0) return chalk.dim("  No hotels found.");

  return hotels
    .map((h, i) => {
      const name = h.name ?? "Unknown Hotel";
      const amt = h.price?.amount;
      const price = amt != null ? `$${amt.toLocaleString()}` : "";
      const stars = h.rating != null && h.rating > 0 ? chalk.yellow("★".repeat(Math.min(Math.round(h.rating), 5))) : "";
      const review = h.reviewScore != null ? `${h.reviewScore}/10` : "";
      const address = h.address ?? "";

      const details = [address, review].filter(Boolean).join("  ·  ");
      const optionId = h.id ? chalk.dim(`Option ${i + 1}: ${h.id.slice(0, 8)}`) : chalk.dim(`Option ${i + 1}`);

      return [
        `  🏨  ${chalk.bold(name)}  ·  ${chalk.yellow(price)}  ${stars}`,
        details ? `     ${chalk.dim(details)}` : null,
        `     ${optionId}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
