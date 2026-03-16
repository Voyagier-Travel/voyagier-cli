export interface Airport {
  code: string;
  city: string;
  name: string;
  country: string;
}

export const AIRPORTS: Airport[] = [
  // United States - Major Hubs
  { code: "ATL", city: "Atlanta", name: "Hartsfield-Jackson Atlanta International", country: "US" },
  { code: "LAX", city: "Los Angeles", name: "Los Angeles International", country: "US" },
  { code: "ORD", city: "Chicago", name: "O'Hare International", country: "US" },
  { code: "DFW", city: "Dallas", name: "Dallas/Fort Worth International", country: "US" },
  { code: "DEN", city: "Denver", name: "Denver International", country: "US" },
  { code: "JFK", city: "New York", name: "John F. Kennedy International", country: "US" },
  { code: "SFO", city: "San Francisco", name: "San Francisco International", country: "US" },
  { code: "SEA", city: "Seattle", name: "Seattle-Tacoma International", country: "US" },
  { code: "LAS", city: "Las Vegas", name: "Harry Reid International", country: "US" },
  { code: "MCO", city: "Orlando", name: "Orlando International", country: "US" },
  { code: "EWR", city: "Newark", name: "Newark Liberty International", country: "US" },
  { code: "MIA", city: "Miami", name: "Miami International", country: "US" },
  { code: "PHX", city: "Phoenix", name: "Phoenix Sky Harbor International", country: "US" },
  { code: "IAH", city: "Houston", name: "George Bush Intercontinental", country: "US" },
  { code: "BOS", city: "Boston", name: "Logan International", country: "US" },
  { code: "MSP", city: "Minneapolis", name: "Minneapolis-Saint Paul International", country: "US" },
  { code: "DTW", city: "Detroit", name: "Detroit Metropolitan Wayne County", country: "US" },
  { code: "FLL", city: "Fort Lauderdale", name: "Fort Lauderdale-Hollywood International", country: "US" },
  { code: "PHL", city: "Philadelphia", name: "Philadelphia International", country: "US" },
  { code: "LGA", city: "New York", name: "LaGuardia", country: "US" },
  { code: "BWI", city: "Baltimore", name: "Baltimore/Washington International", country: "US" },
  { code: "DCA", city: "Washington", name: "Ronald Reagan Washington National", country: "US" },
  { code: "IAD", city: "Washington", name: "Washington Dulles International", country: "US" },
  { code: "SLC", city: "Salt Lake City", name: "Salt Lake City International", country: "US" },
  { code: "SAN", city: "San Diego", name: "San Diego International", country: "US" },
  { code: "MDW", city: "Chicago", name: "Chicago Midway International", country: "US" },
  { code: "TPA", city: "Tampa", name: "Tampa International", country: "US" },
  { code: "PDX", city: "Portland", name: "Portland International", country: "US" },
  { code: "STL", city: "St. Louis", name: "St. Louis Lambert International", country: "US" },
  { code: "HNL", city: "Honolulu", name: "Daniel K. Inouye International", country: "US" },
  { code: "BNA", city: "Nashville", name: "Nashville International", country: "US" },
  { code: "AUS", city: "Austin", name: "Austin-Bergstrom International", country: "US" },
  { code: "DAL", city: "Dallas", name: "Dallas Love Field", country: "US" },
  { code: "HOU", city: "Houston", name: "William P. Hobby", country: "US" },
  { code: "OAK", city: "Oakland", name: "Oakland International", country: "US" },
  { code: "SJC", city: "San Jose", name: "Norman Y. Mineta San Jose International", country: "US" },
  { code: "RDU", city: "Raleigh", name: "Raleigh-Durham International", country: "US" },
  { code: "MCI", city: "Kansas City", name: "Kansas City International", country: "US" },
  { code: "SMF", city: "Sacramento", name: "Sacramento International", country: "US" },
  { code: "IND", city: "Indianapolis", name: "Indianapolis International", country: "US" },
  { code: "PIT", city: "Pittsburgh", name: "Pittsburgh International", country: "US" },
  { code: "CMH", city: "Columbus", name: "John Glenn Columbus International", country: "US" },
  { code: "MSY", city: "New Orleans", name: "Louis Armstrong New Orleans International", country: "US" },
  { code: "SAT", city: "San Antonio", name: "San Antonio International", country: "US" },
  { code: "CLE", city: "Cleveland", name: "Cleveland Hopkins International", country: "US" },
  { code: "MEM", city: "Memphis", name: "Memphis International", country: "US" },
  { code: "OGG", city: "Maui", name: "Kahului", country: "US" },
  { code: "ABQ", city: "Albuquerque", name: "Albuquerque International Sunport", country: "US" },
  { code: "OMA", city: "Omaha", name: "Eppley Airfield", country: "US" },
  { code: "BUF", city: "Buffalo", name: "Buffalo Niagara International", country: "US" },
  { code: "ORF", city: "Norfolk", name: "Norfolk International", country: "US" },
  { code: "GRR", city: "Grand Rapids", name: "Gerald R. Ford International", country: "US" },
  { code: "TUL", city: "Tulsa", name: "Tulsa International", country: "US" },
  { code: "OKC", city: "Oklahoma City", name: "Will Rogers World", country: "US" },
  { code: "BDL", city: "Hartford", name: "Bradley International", country: "US" },
  { code: "ALB", city: "Albany", name: "Albany International", country: "US" },
  { code: "MKE", city: "Milwaukee", name: "Milwaukee Mitchell International", country: "US" },
  { code: "ANC", city: "Anchorage", name: "Ted Stevens Anchorage International", country: "US" },
  { code: "ELP", city: "El Paso", name: "El Paso International", country: "US" },
  { code: "BOI", city: "Boise", name: "Boise Airport", country: "US" },
  { code: "TUS", city: "Tucson", name: "Tucson International", country: "US" },
  { code: "GEG", city: "Spokane", name: "Spokane International", country: "US" },
  { code: "ROC", city: "Rochester", name: "Greater Rochester International", country: "US" },
  { code: "SYR", city: "Syracuse", name: "Syracuse Hancock International", country: "US" },
  { code: "CVG", city: "Cincinnati", name: "Cincinnati/Northern Kentucky International", country: "US" },
  { code: "JAX", city: "Jacksonville", name: "Jacksonville International", country: "US" },
  { code: "LIT", city: "Little Rock", name: "Bill and Hillary Clinton National", country: "US" },
  { code: "DSM", city: "Des Moines", name: "Des Moines International", country: "US" },
  { code: "BHM", city: "Birmingham", name: "Birmingham-Shuttlesworth International", country: "US" },
  { code: "GSP", city: "Greenville", name: "Greenville-Spartanburg International", country: "US" },
  { code: "CHS", city: "Charleston", name: "Charleston International", country: "US" },
  { code: "SDF", city: "Louisville", name: "Louisville Muhammad Ali International", country: "US" },
  { code: "RSW", city: "Fort Myers", name: "Southwest Florida International", country: "US" },
  { code: "PBI", city: "West Palm Beach", name: "Palm Beach International", country: "US" },
  { code: "SRQ", city: "Sarasota", name: "Sarasota Bradenton International", country: "US" },
  { code: "CAE", city: "Columbia", name: "Columbia Metropolitan", country: "US" },
  { code: "FAT", city: "Fresno", name: "Fresno Yosemite International", country: "US" },
  { code: "BUR", city: "Burbank", name: "Hollywood Burbank", country: "US" },
  { code: "LGB", city: "Long Beach", name: "Long Beach Airport", country: "US" },
  { code: "ONT", city: "Ontario", name: "Ontario International", country: "US" },

  // Canada
  { code: "YYZ", city: "Toronto", name: "Toronto Pearson International", country: "CA" },
  { code: "YVR", city: "Vancouver", name: "Vancouver International", country: "CA" },
  { code: "YUL", city: "Montreal", name: "Montréal-Trudeau International", country: "CA" },
  { code: "YYC", city: "Calgary", name: "Calgary International", country: "CA" },
  { code: "YEG", city: "Edmonton", name: "Edmonton International", country: "CA" },
  { code: "YOW", city: "Ottawa", name: "Ottawa Macdonald-Cartier International", country: "CA" },
  { code: "YHZ", city: "Halifax", name: "Halifax Stanfield International", country: "CA" },
  { code: "YWG", city: "Winnipeg", name: "Winnipeg James Armstrong Richardson International", country: "CA" },

  // Europe
  { code: "LHR", city: "London", name: "Heathrow", country: "GB" },
  { code: "LGW", city: "London", name: "Gatwick", country: "GB" },
  { code: "STN", city: "London", name: "Stansted", country: "GB" },
  { code: "LCY", city: "London", name: "London City", country: "GB" },
  { code: "MAN", city: "Manchester", name: "Manchester Airport", country: "GB" },
  { code: "EDI", city: "Edinburgh", name: "Edinburgh Airport", country: "GB" },
  { code: "GLA", city: "Glasgow", name: "Glasgow International", country: "GB" },
  { code: "CDG", city: "Paris", name: "Charles de Gaulle", country: "FR" },
  { code: "ORY", city: "Paris", name: "Paris Orly", country: "FR" },
  { code: "NCE", city: "Nice", name: "Nice Côte d'Azur", country: "FR" },
  { code: "AMS", city: "Amsterdam", name: "Amsterdam Airport Schiphol", country: "NL" },
  { code: "FRA", city: "Frankfurt", name: "Frankfurt Airport", country: "DE" },
  { code: "MUC", city: "Munich", name: "Munich Airport", country: "DE" },
  { code: "BER", city: "Berlin", name: "Berlin Brandenburg", country: "DE" },
  { code: "HAM", city: "Hamburg", name: "Hamburg Airport", country: "DE" },
  { code: "DUS", city: "Düsseldorf", name: "Düsseldorf Airport", country: "DE" },
  { code: "MAD", city: "Madrid", name: "Adolfo Suárez Madrid-Barajas", country: "ES" },
  { code: "BCN", city: "Barcelona", name: "Barcelona El Prat", country: "ES" },
  { code: "FCO", city: "Rome", name: "Leonardo da Vinci–Fiumicino", country: "IT" },
  { code: "MXP", city: "Milan", name: "Milan Malpensa", country: "IT" },
  { code: "VCE", city: "Venice", name: "Venice Marco Polo", country: "IT" },
  { code: "NAP", city: "Naples", name: "Naples International", country: "IT" },
  { code: "ZRH", city: "Zurich", name: "Zurich Airport", country: "CH" },
  { code: "GVA", city: "Geneva", name: "Geneva Airport", country: "CH" },
  { code: "VIE", city: "Vienna", name: "Vienna International", country: "AT" },
  { code: "BRU", city: "Brussels", name: "Brussels Airport", country: "BE" },
  { code: "LIS", city: "Lisbon", name: "Humberto Delgado", country: "PT" },
  { code: "OPO", city: "Porto", name: "Francisco de Sá Carneiro", country: "PT" },
  { code: "CPH", city: "Copenhagen", name: "Copenhagen Airport", country: "DK" },
  { code: "ARN", city: "Stockholm", name: "Stockholm Arlanda", country: "SE" },
  { code: "OSL", city: "Oslo", name: "Oslo Gardermoen", country: "NO" },
  { code: "HEL", city: "Helsinki", name: "Helsinki-Vantaa", country: "FI" },
  { code: "WAW", city: "Warsaw", name: "Warsaw Chopin", country: "PL" },
  { code: "PRG", city: "Prague", name: "Václav Havel Airport Prague", country: "CZ" },
  { code: "BUD", city: "Budapest", name: "Budapest Ferenc Liszt International", country: "HU" },
  { code: "ATH", city: "Athens", name: "Athens International Eleftherios Venizelos", country: "GR" },
  { code: "IST", city: "Istanbul", name: "Istanbul Airport", country: "TR" },
  { code: "SAW", city: "Istanbul", name: "Sabiha Gökçen International", country: "TR" },
  { code: "SVO", city: "Moscow", name: "Sheremetyevo International", country: "RU" },
  { code: "DME", city: "Moscow", name: "Domodedovo International", country: "RU" },

  // Asia-Pacific
  { code: "NRT", city: "Tokyo", name: "Narita International", country: "JP" },
  { code: "HND", city: "Tokyo", name: "Tokyo Haneda", country: "JP" },
  { code: "KIX", city: "Osaka", name: "Kansai International", country: "JP" },
  { code: "ITM", city: "Osaka", name: "Itami Airport", country: "JP" },
  { code: "NGO", city: "Nagoya", name: "Chubu Centrair International", country: "JP" },
  { code: "CTS", city: "Sapporo", name: "New Chitose", country: "JP" },
  { code: "FUK", city: "Fukuoka", name: "Fukuoka Airport", country: "JP" },
  { code: "ICN", city: "Seoul", name: "Incheon International", country: "KR" },
  { code: "GMP", city: "Seoul", name: "Gimpo International", country: "KR" },
  { code: "PEK", city: "Beijing", name: "Beijing Capital International", country: "CN" },
  { code: "PKX", city: "Beijing", name: "Beijing Daxing International", country: "CN" },
  { code: "PVG", city: "Shanghai", name: "Shanghai Pudong International", country: "CN" },
  { code: "SHA", city: "Shanghai", name: "Shanghai Hongqiao International", country: "CN" },
  { code: "CAN", city: "Guangzhou", name: "Guangzhou Baiyun International", country: "CN" },
  { code: "SZX", city: "Shenzhen", name: "Shenzhen Bao'an International", country: "CN" },
  { code: "CTU", city: "Chengdu", name: "Chengdu Tianfu International", country: "CN" },
  { code: "HKG", city: "Hong Kong", name: "Hong Kong International", country: "HK" },
  { code: "TPE", city: "Taipei", name: "Taiwan Taoyuan International", country: "TW" },
  { code: "SIN", city: "Singapore", name: "Singapore Changi", country: "SG" },
  { code: "KUL", city: "Kuala Lumpur", name: "Kuala Lumpur International", country: "MY" },
  { code: "BKK", city: "Bangkok", name: "Suvarnabhumi", country: "TH" },
  { code: "DMK", city: "Bangkok", name: "Don Mueang International", country: "TH" },
  { code: "CGK", city: "Jakarta", name: "Soekarno-Hatta International", country: "ID" },
  { code: "DPS", city: "Bali", name: "Ngurah Rai International", country: "ID" },
  { code: "MNL", city: "Manila", name: "Ninoy Aquino International", country: "PH" },
  { code: "SGN", city: "Ho Chi Minh City", name: "Tan Son Nhat International", country: "VN" },
  { code: "HAN", city: "Hanoi", name: "Noi Bai International", country: "VN" },
  { code: "DAD", city: "Da Nang", name: "Da Nang International", country: "VN" },
  { code: "BOM", city: "Mumbai", name: "Chhatrapati Shivaji Maharaj International", country: "IN" },
  { code: "DEL", city: "Delhi", name: "Indira Gandhi International", country: "IN" },
  { code: "BLR", city: "Bangalore", name: "Kempegowda International", country: "IN" },
  { code: "MAA", city: "Chennai", name: "Chennai International", country: "IN" },
  { code: "CCU", city: "Kolkata", name: "Netaji Subhas Chandra Bose International", country: "IN" },
  { code: "HYD", city: "Hyderabad", name: "Rajiv Gandhi International", country: "IN" },
  { code: "DXB", city: "Dubai", name: "Dubai International", country: "AE" },
  { code: "AUH", city: "Abu Dhabi", name: "Abu Dhabi International", country: "AE" },
  { code: "DOH", city: "Doha", name: "Hamad International", country: "QA" },
  { code: "KWI", city: "Kuwait City", name: "Kuwait International", country: "KW" },
  { code: "BAH", city: "Bahrain", name: "Bahrain International", country: "BH" },
  { code: "RUH", city: "Riyadh", name: "King Khalid International", country: "SA" },
  { code: "JED", city: "Jeddah", name: "King Abdulaziz International", country: "SA" },
  { code: "TLV", city: "Tel Aviv", name: "Ben Gurion International", country: "IL" },
  { code: "AMM", city: "Amman", name: "Queen Alia International", country: "JO" },
  { code: "BEY", city: "Beirut", name: "Rafic Hariri International", country: "LB" },
  { code: "SYD", city: "Sydney", name: "Sydney Kingsford Smith", country: "AU" },
  { code: "MEL", city: "Melbourne", name: "Melbourne Airport", country: "AU" },
  { code: "BNE", city: "Brisbane", name: "Brisbane Airport", country: "AU" },
  { code: "PER", city: "Perth", name: "Perth Airport", country: "AU" },
  { code: "ADL", city: "Adelaide", name: "Adelaide Airport", country: "AU" },
  { code: "AKL", city: "Auckland", name: "Auckland Airport", country: "NZ" },
  { code: "CHC", city: "Christchurch", name: "Christchurch International", country: "NZ" },

  // Latin America
  { code: "GRU", city: "São Paulo", name: "São Paulo–Guarulhos International", country: "BR" },
  { code: "GIG", city: "Rio de Janeiro", name: "Rio de Janeiro–Galeão International", country: "BR" },
  { code: "BSB", city: "Brasília", name: "Brasília International", country: "BR" },
  { code: "SSA", city: "Salvador", name: "Deputado Luís Eduardo Magalhães International", country: "BR" },
  { code: "EZE", city: "Buenos Aires", name: "Ministro Pistarini International", country: "AR" },
  { code: "AEP", city: "Buenos Aires", name: "Jorge Newbery Airfield", country: "AR" },
  { code: "SCL", city: "Santiago", name: "Arturo Merino Benítez International", country: "CL" },
  { code: "LIM", city: "Lima", name: "Jorge Chávez International", country: "PE" },
  { code: "BOG", city: "Bogotá", name: "El Dorado International", country: "CO" },
  { code: "MDE", city: "Medellín", name: "José María Córdova International", country: "CO" },
  { code: "CCS", city: "Caracas", name: "Simón Bolívar International", country: "VE" },
  { code: "UIO", city: "Quito", name: "Mariscal Sucre International", country: "EC" },
  { code: "MEX", city: "Mexico City", name: "Benito Juárez International", country: "MX" },
  { code: "CUN", city: "Cancún", name: "Cancún International", country: "MX" },
  { code: "GDL", city: "Guadalajara", name: "Miguel Hidalgo y Costilla International", country: "MX" },
  { code: "MTY", city: "Monterrey", name: "General Mariano Escobedo International", country: "MX" },
  { code: "SJO", city: "San José", name: "Juan Santamaría International", country: "CR" },
  { code: "PTY", city: "Panama City", name: "Tocumen International", country: "PA" },
  { code: "MBJ", city: "Montego Bay", name: "Sangster International", country: "JM" },
  { code: "NAS", city: "Nassau", name: "Lynden Pindling International", country: "BS" },
  { code: "PUJ", city: "Punta Cana", name: "Punta Cana International", country: "DO" },
  { code: "SDQ", city: "Santo Domingo", name: "Las Américas International", country: "DO" },

  // Africa
  { code: "JNB", city: "Johannesburg", name: "O.R. Tambo International", country: "ZA" },
  { code: "CPT", city: "Cape Town", name: "Cape Town International", country: "ZA" },
  { code: "DUR", city: "Durban", name: "King Shaka International", country: "ZA" },
  { code: "CAI", city: "Cairo", name: "Cairo International", country: "EG" },
  { code: "LOS", city: "Lagos", name: "Murtala Muhammed International", country: "NG" },
  { code: "ABV", city: "Abuja", name: "Nnamdi Azikiwe International", country: "NG" },
  { code: "NBO", city: "Nairobi", name: "Jomo Kenyatta International", country: "KE" },
  { code: "ADD", city: "Addis Ababa", name: "Bole International", country: "ET" },
  { code: "CMN", city: "Casablanca", name: "Mohammed V International", country: "MA" },
  { code: "TUN", city: "Tunis", name: "Tunis-Carthage International", country: "TN" },
  { code: "ALG", city: "Algiers", name: "Houari Boumediene", country: "DZ" },
  { code: "ACC", city: "Accra", name: "Kotoka International", country: "GH" },
  { code: "DAR", city: "Dar es Salaam", name: "Julius Nyerere International", country: "TZ" },
];

/**
 * Resolve an airport from user input.
 * - If input is exactly 3 uppercase letters, treat as IATA code lookup.
 * - Otherwise, fuzzy-match on city name.
 * - Returns null if ambiguous (multiple matches) or not found.
 */
export function resolveAirport(input: string): { code: string; city: string; name: string } | null {
  const trimmed = input.trim();

  // Exact IATA code lookup (3 letters, case-insensitive)
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    const match = AIRPORTS.find((a) => a.code === upper);
    if (match) return { code: match.code, city: match.city, name: match.name };
    return null; // Unknown 3-letter code — let caller decide
  }

  // Fuzzy city name match
  const matches = searchAirports(trimmed);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  // Ambiguous — multiple matches
  return null;
}

/**
 * Search airports by city name or partial IATA code (case-insensitive).
 * Returns all matching airports.
 */
export function searchAirports(query: string): Array<{ code: string; city: string; name: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return AIRPORTS
    .filter((a) => {
      const cityMatch = a.city.toLowerCase().includes(q);
      const codeMatch = a.code.toLowerCase().startsWith(q);
      const nameMatch = a.name.toLowerCase().includes(q);
      return cityMatch || codeMatch || nameMatch;
    })
    .map((a) => ({ code: a.code, city: a.city, name: a.name }));
}
