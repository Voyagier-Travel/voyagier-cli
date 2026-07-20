/**
 * Shared chosen-state derivation for the participant-choice model
 * (VOY-1692 / VOY-1701).
 *
 * Since the July 2026 backend migration, picks are recorded as per-traveller
 * `travellerOptionChoices` rows; the legacy `parentOptionId` column is NOT
 * written by new-model picks. Any view that derives "what was chosen" from
 * `parentOptionId` alone is blind to new picks — every chosen-state read in
 * the CLI must go through `deriveChosen`.
 */

export interface RawTravellerChoice {
  traveller?: { id: string; firstName?: string | null; lastName?: string | null } | null;
  selectedOption?: { id: string } | null;
  scope?: string | null;
}

export interface ChoiceBearingSelection {
  travellerOptionChoices?: RawTravellerChoice[] | null;
  parentOptionId?: string | null;
}

/**
 * Consensus requires EVERY travellerOptionChoices entry to carry a pick AND
 * all picks to match — a partial pick (some travellers still undecided) is
 * NOT consensus. Falls back to the legacy parentOptionId only when no choice
 * entries exist at all.
 */
export function deriveChosen(raw: ChoiceBearingSelection): {
  chosenOptionId: string | null;
  consensus: boolean;
} {
  const entries = raw.travellerOptionChoices ?? [];
  if (entries.length === 0) {
    return { chosenOptionId: raw.parentOptionId ?? null, consensus: raw.parentOptionId != null };
  }
  const allPicked = entries.every((c) => c.selectedOption?.id);
  const ids = [...new Set(entries.filter((c) => c.selectedOption?.id).map((c) => c.selectedOption!.id))];
  const consensus = allPicked && ids.length === 1;
  return { chosenOptionId: consensus ? ids[0] : null, consensus };
}
