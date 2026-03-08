import chalk from "chalk";

interface FlightOption {
  id?: string;
  origin?: string;
  destination?: string;
  price?: number;
  currency?: string;
  duration?: string;
  stops?: number;
  stopCities?: string[];
  carrier?: string;
  flightNumber?: string;
  departureTime?: string;
  cabinClass?: string;
  segments?: Array<{ carrier?: string; flightNumber?: string | number }>;
}

interface HotelOption {
  id?: string;
  name?: string;
  pricePerNight?: number;
  totalPrice?: number;
  currency?: string;
  rating?: number;
  location?: string;
  checkin?: string;
  checkout?: string;
  nights?: number;
}

export function formatFlights(flights: FlightOption[]): string {
  if (!flights || flights.length === 0) return chalk.dim("  No flights found.");

  return flights
    .map((f, i) => {
      const route = `${f.origin ?? "?"} → ${f.destination ?? "?"}`;
      const price = f.price != null ? `$${f.price.toLocaleString()}` : "Price N/A";
      const duration = f.duration ?? "?";
      const stopLabel =
        f.stops === 0 || f.stops == null
          ? chalk.green("Nonstop")
          : `${f.stops} stop${f.stops > 1 ? "s" : ""}${f.stopCities?.length ? ` (${f.stopCities.join(", ")})` : ""}`;

      const segments = f.segments?.map((s) => `${s.carrier ?? ""}${s.flightNumber ?? ""}`).join(" → ") ??
        (f.carrier && f.flightNumber ? `${f.carrier} ${f.flightNumber}` : "");
      const depart = f.departureTime ? `Departs ${f.departureTime}` : "";
      const cabin = f.cabinClass ?? "";

      const details = [segments, depart, cabin].filter(Boolean).join("  ·  ");
      const optionId = f.id ? chalk.dim(`Option ${i + 1}: ${f.id.slice(0, 8)}`) : chalk.dim(`Option ${i + 1}`);

      return [
        `  ✈️  ${chalk.bold(route)}  ·  ${chalk.yellow(price)}  ·  ${duration}  ·  ${stopLabel}`,
        details ? `     ${chalk.dim(details)}` : null,
        `     ${optionId}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function formatHotels(hotels: HotelOption[]): string {
  if (!hotels || hotels.length === 0) return chalk.dim("  No hotels found.");

  return hotels
    .map((h, i) => {
      const name = h.name ?? "Unknown Hotel";
      const perNight = h.pricePerNight != null ? `$${h.pricePerNight.toLocaleString()}/night` : "";
      const stars = h.rating != null ? "★".repeat(Math.min(h.rating, 5)) : "";
      const location = h.location ?? "";
      const dates = h.checkin && h.checkout ? `${h.checkin} – ${h.checkout}` : "";
      const nights = h.nights != null ? `(${h.nights} night${h.nights > 1 ? "s" : ""})` : "";
      const total = h.totalPrice != null ? `Total: $${h.totalPrice.toLocaleString()}` : "";

      const details = [location, dates, nights, total].filter(Boolean).join("  ·  ");
      const optionId = h.id ? chalk.dim(`Option ${i + 1}: ${h.id.slice(0, 8)}`) : chalk.dim(`Option ${i + 1}`);

      return [
        `  🏨  ${chalk.bold(name)}  ·  ${chalk.yellow(perNight)}  ${stars ? chalk.yellow(stars) : ""}`,
        details ? `     ${chalk.dim(details)}` : null,
        `     ${optionId}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function formatToolResult(toolName: string, data: Record<string, unknown>): string {
  if (toolName.includes("flight") || toolName === "voyagier_plan_trip") {
    const flights = (data.flights ?? data.options ?? []) as FlightOption[];
    if (flights.length > 0) {
      const parts = [chalk.bold("\nFlights:"), formatFlights(flights)];
      const hotels = (data.hotels ?? []) as HotelOption[];
      if (hotels.length > 0) {
        parts.push("", chalk.bold("Hotels:"), formatHotels(hotels));
      }
      return parts.join("\n");
    }
  }

  if (toolName.includes("hotel")) {
    const hotels = (data.hotels ?? data.options ?? []) as HotelOption[];
    if (hotels.length > 0) {
      return [chalk.bold("\nHotels:"), formatHotels(hotels)].join("\n");
    }
  }

  // Fallback: pretty-print JSON
  return chalk.dim(JSON.stringify(data, null, 2));
}
