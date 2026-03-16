/**
 * Metropolitan area airport groupings.
 * Maps common metro names/aliases to their IATA airport codes.
 *
 * Use case: when a user searches "Washington DC" or "New York", return all
 * airports serving that metro area instead of erroring on ambiguity.
 *
 * Source: manually curated for major travel markets.
 * Add new metros as needed — especially any market where Voyagier advisors book frequently.
 */

export interface MetroArea {
  /** Canonical metro name shown to users */
  name: string;
  /** All search terms that should match this metro (lowercase) */
  aliases: string[];
  /** IATA codes for airports serving this metro, ordered by traffic volume */
  airports: string[];
}

export const METRO_AREAS: MetroArea[] = [
  // United States
  {
    name: "Washington, DC Metro",
    aliases: ["washington", "dc", "washington dc", "dmv", "baltimore", "bmore", "baltimore-washington"],
    airports: ["DCA", "IAD", "BWI"],
  },
  {
    name: "New York Metro",
    aliases: ["new york", "nyc", "manhattan", "brooklyn", "new york city"],
    airports: ["JFK", "LGA", "EWR"],
  },
  {
    name: "Los Angeles Metro",
    aliases: ["los angeles", "la", "hollywood", "southern california", "socal"],
    airports: ["LAX", "SNA", "BUR", "ONT", "LGB"],
  },
  {
    name: "San Francisco Bay Area",
    aliases: ["san francisco", "sf", "bay area", "silicon valley", "oakland", "san jose"],
    airports: ["SFO", "OAK", "SJC"],
  },
  {
    name: "Chicago Metro",
    aliases: ["chicago", "chi-town", "chitown"],
    airports: ["ORD", "MDW"],
  },
  {
    name: "Dallas-Fort Worth Metro",
    aliases: ["dallas", "fort worth", "dfw"],
    airports: ["DFW", "DAL"],
  },
  {
    name: "Houston Metro",
    aliases: ["houston"],
    airports: ["IAH", "HOU"],
  },
  {
    name: "Miami/South Florida",
    aliases: ["miami", "south florida", "fort lauderdale", "west palm beach"],
    airports: ["MIA", "FLL", "PBI"],
  },
  {
    name: "Detroit Metro",
    aliases: ["detroit"],
    airports: ["DTW", "YQG"],
  },
  {
    name: "Seattle Metro",
    aliases: ["seattle", "tacoma"],
    airports: ["SEA", "PAE"],
  },

  // International
  {
    name: "London",
    aliases: ["london", "england"],
    airports: ["LHR", "LGW", "STN", "LCY", "LTN"],
  },
  {
    name: "Paris",
    aliases: ["paris"],
    airports: ["CDG", "ORY"],
  },
  {
    name: "Tokyo",
    aliases: ["tokyo"],
    airports: ["NRT", "HND"],
  },
  {
    name: "Shanghai",
    aliases: ["shanghai"],
    airports: ["PVG", "SHA"],
  },
  {
    name: "Beijing",
    aliases: ["beijing", "peking"],
    airports: ["PEK", "PKX"],
  },
  {
    name: "Seoul",
    aliases: ["seoul"],
    airports: ["ICN", "GMP"],
  },
  {
    name: "São Paulo",
    aliases: ["sao paulo", "são paulo"],
    airports: ["GRU", "CGH", "VCP"],
  },
  {
    name: "Buenos Aires",
    aliases: ["buenos aires"],
    airports: ["EZE", "AEP"],
  },
  {
    name: "Milan",
    aliases: ["milan", "milano"],
    airports: ["MXP", "LIN", "BGY"],
  },
  {
    name: "Rome",
    aliases: ["rome", "roma"],
    airports: ["FCO", "CIA"],
  },
  {
    name: "Istanbul",
    aliases: ["istanbul"],
    airports: ["IST", "SAW"],
  },
  {
    name: "Bangkok",
    aliases: ["bangkok"],
    airports: ["BKK", "DMK"],
  },
  {
    name: "Taipei",
    aliases: ["taipei"],
    airports: ["TPE", "TSA"],
  },
  {
    name: "Osaka",
    aliases: ["osaka"],
    airports: ["KIX", "ITM"],
  },
  {
    name: "Jakarta",
    aliases: ["jakarta"],
    airports: ["CGK", "HLP"],
  },
  {
    name: "Kuala Lumpur",
    aliases: ["kuala lumpur", "kl"],
    airports: ["KUL", "SZB"],
  },
  {
    name: "Moscow",
    aliases: ["moscow"],
    airports: ["SVO", "DME", "VKO"],
  },
  {
    name: "Stockholm",
    aliases: ["stockholm"],
    airports: ["ARN", "BMA"],
  },
  {
    name: "Nairobi",
    aliases: ["nairobi"],
    airports: ["NBO", "WIL"],
  },
  {
    name: "Rio de Janeiro",
    aliases: ["rio", "rio de janeiro"],
    airports: ["GIG", "SDU"],
  },
  {
    name: "Toronto",
    aliases: ["toronto"],
    airports: ["YYZ", "YTZ"],
  },
  {
    name: "Montreal",
    aliases: ["montreal", "montréal"],
    airports: ["YUL", "YMX"],
  },
];

/**
 * Find a metro area matching the query.
 * Returns the metro if any alias matches (case-insensitive, partial match).
 */
export function findMetroArea(query: string): MetroArea | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  // Exact alias match first
  const exact = METRO_AREAS.find((m) => m.aliases.some((a) => a === q));
  if (exact) return exact;
  // Partial match
  const partial = METRO_AREAS.find((m) => m.aliases.some((a) => a.includes(q) || q.includes(a)));
  return partial ?? null;
}
