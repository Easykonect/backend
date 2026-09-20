/**
 * Search Aliases
 *
 * A small, deliberately hand-written map of the words customers type to the
 * words listings actually use ("painter" vs "Painting Services"). It is only
 * consulted when a normal search returns nothing, so an exact match always
 * wins. Keep it short and obvious: this is not a language engine.
 *
 * Add an entry when support sees a search that should have worked.
 */
export const SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // trades
  painter: ['painting', 'paint'],
  plumber: ['plumbing'],
  cleaner: ['cleaning'],
  electrician: ['electrical', 'electric'],
  carpenter: ['carpentry', 'furniture'],
  welder: ['welding'],
  tiler: ['tiling', 'tiles'],
  bricklayer: ['masonry', 'building'],
  roofer: ['roofing'],
  plasterer: ['plastering', 'screeding'],
  // vehicles and transport
  mechanic: ['automobile', 'automotive', 'auto', 'car repair'],
  driver: ['driving', 'transport'],
  mover: ['moving', 'haulage', 'logistics'],
  // home and grounds
  gardener: ['gardening', 'landscaping'],
  fumigator: ['fumigation', 'pest control'],
  launderer: ['laundry', 'dry cleaning'],
  'ac technician': ['air conditioning', 'air conditioner', 'hvac'],
  'generator technician': ['generator repair', 'generator'],
  // personal services
  barber: ['barbing', 'haircut', 'salon'],
  hairdresser: ['hair', 'salon', 'hairstyling'],
  'makeup artist': ['makeup', 'make up'],
  tailor: ['tailoring', 'fashion design', 'sewing'],
  photographer: ['photography'],
  videographer: ['videography'],
  caterer: ['catering', 'food'],
  baker: ['baking', 'cake'],
  // technology
  'phone repair': ['phone repairs', 'gadget repair'],
  'laptop repair': ['computer repair', 'it support'],
};

/**
 * Alternative words to try for a search that found nothing, or an empty list
 * when the term isn't in the map. Matching is on the whole phrase, then on a
 * simple singular of it ("painters" -> "painter").
 */
export const aliasesFor = (term: string): string[] => {
  const normalized = term.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const direct = SEARCH_ALIASES[normalized];
  if (direct) return [...direct];

  // "painters" -> "painter", "mechanics" -> "mechanic"
  if (normalized.endsWith('s')) {
    const singular = SEARCH_ALIASES[normalized.slice(0, -1)];
    if (singular) return [...singular];
  }

  return [];
};
