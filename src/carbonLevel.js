// -----------------------------------------------------------------------------
// Carbon level: the carbon intensity read as a BAND rather than as a number.
//
// Why a band at all. The carbon intensity is a state, and a state belongs to a
// device feature: a scene that wants "below 80 gCO2eq/kWh" already has the
// sensor and the core's own threshold trigger. What the core cannot express is
// the TRANSITION — "the grid just became clean" — because that needs the
// previous value, a hysteresis and a vocabulary the user can read. That is what
// this module builds, and what the `carbon_level_changed` scene trigger fires
// (see src/devices/gridCarbon.js).
//
// The bands are FIXED and absolute, not relative to the zone: they are the
// numbers a household acts on, and a moving reference would make a scene mean
// something different every week. They follow the usual reading of the
// Electricity Maps colour scale:
//
//   very low   <  100 gCO2eq/kWh   a nuclear/hydro/wind-heavy grid
//   low        <  200              still clean
//   moderate   <  400              mixed
//   high       <  600              gas-heavy
//   very high  >= 600              coal-heavy
//
// HYSTERESIS. A value sitting on a boundary would otherwise flip the level on
// every refresh and start the scene again each time. A level therefore only
// changes once the value has moved PAST the boundary by `HYSTERESIS`, which
// makes the trigger fire once per real transition.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

/** Level keys, as published in the scene event and declared in the manifest. */
export const CARBON_LEVELS = {
  VERY_LOW: 'very_low',
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high',
  VERY_HIGH: 'very_high',
};

/**
 * Bands, from the cleanest to the dirtiest. `max` is the exclusive upper bound
 * in gCO2eq/kWh; the last band has none.
 */
export const CARBON_LEVEL_BANDS = [
  { key: CARBON_LEVELS.VERY_LOW, max: 100 },
  { key: CARBON_LEVELS.LOW, max: 200 },
  { key: CARBON_LEVELS.MODERATE, max: 400 },
  { key: CARBON_LEVELS.HIGH, max: 600 },
  { key: CARBON_LEVELS.VERY_HIGH, max: Infinity },
];

/**
 * How far past a boundary the value must move before the level follows, in
 * gCO2eq/kWh. Small in front of the narrowest band (100), large enough to
 * absorb the wobble of an hourly-refreshed figure.
 */
export const CARBON_LEVEL_HYSTERESIS = 10;

/** Directions of a level change, as published in the scene event. */
export const CARBON_LEVEL_DIRECTIONS = {
  CLEANER: 'cleaner',
  DIRTIER: 'dirtier',
};

// Multi-language labels, used by the widget (the manifest carries its own copy
// for the scene editor, which is rendered by the core without asking us).
const CARBON_LEVEL_LABELS = {
  [CARBON_LEVELS.VERY_LOW]: { en: 'Very low', fr: 'Très faible' },
  [CARBON_LEVELS.LOW]: { en: 'Low', fr: 'Faible' },
  [CARBON_LEVELS.MODERATE]: { en: 'Moderate', fr: 'Modéré' },
  [CARBON_LEVELS.HIGH]: { en: 'High', fr: 'Élevé' },
  [CARBON_LEVELS.VERY_HIGH]: { en: 'Very high', fr: 'Très élevé' },
};

// Semantic widget colours: the dashboard maps them to the theme, in both light
// and dark mode.
const CARBON_LEVEL_COLORS = {
  [CARBON_LEVELS.VERY_LOW]: WIDGET_COLORS.SUCCESS,
  [CARBON_LEVELS.LOW]: WIDGET_COLORS.SUCCESS,
  [CARBON_LEVELS.MODERATE]: WIDGET_COLORS.WARNING,
  [CARBON_LEVELS.HIGH]: WIDGET_COLORS.DANGER,
  [CARBON_LEVELS.VERY_HIGH]: WIDGET_COLORS.DANGER,
};

/**
 * Band of a carbon intensity, ignoring where it comes from.
 * @param {number} value carbon intensity in gCO2eq/kWh
 * @returns {number} index in CARBON_LEVEL_BANDS
 */
function bandIndex(value) {
  return CARBON_LEVEL_BANDS.findIndex((band) => value < band.max);
}

function indexOfLevel(level) {
  return CARBON_LEVEL_BANDS.findIndex((band) => band.key === level);
}

/**
 * The level a carbon intensity reads as, keeping the previous one while the
 * value has not moved past the boundary by `CARBON_LEVEL_HYSTERESIS`.
 *
 * @param {number|null|undefined} value carbon intensity in gCO2eq/kWh
 * @param {string|null} [previousLevel] level published last time, if any
 * @returns {string|null} a CARBON_LEVELS value, null when there is no usable
 *   number to classify
 */
export function classifyCarbonIntensity(value, previousLevel = null) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const next = bandIndex(value);
  const previous = indexOfLevel(previousLevel);
  if (previous === -1 || next === previous) {
    // No history (first read, or a level key we do not know): take the band as
    // it is.
    return CARBON_LEVEL_BANDS[next].key;
  }
  if (next > previous) {
    // Getting dirtier: the boundary just above the previous band has to be
    // cleared by the margin.
    const boundary = CARBON_LEVEL_BANDS[previous].max;
    return value >= boundary + CARBON_LEVEL_HYSTERESIS
      ? CARBON_LEVEL_BANDS[next].key
      : CARBON_LEVEL_BANDS[previous].key;
  }
  // Getting cleaner: same margin, below the lower bound of the previous band.
  const boundary = CARBON_LEVEL_BANDS[previous - 1].max;
  return value <= boundary - CARBON_LEVEL_HYSTERESIS
    ? CARBON_LEVEL_BANDS[next].key
    : CARBON_LEVEL_BANDS[previous].key;
}

/**
 * Which way a level moved, for the `direction` filter of the scene trigger.
 * @returns {string} a CARBON_LEVEL_DIRECTIONS value
 */
export function carbonLevelDirection(previousLevel, level) {
  return indexOfLevel(level) < indexOfLevel(previousLevel)
    ? CARBON_LEVEL_DIRECTIONS.CLEANER
    : CARBON_LEVEL_DIRECTIONS.DIRTIER;
}

/** Multi-language label of a level, for the widget. */
export function carbonLevelLabel(level) {
  return CARBON_LEVEL_LABELS[level] ?? { en: 'Unknown', fr: 'Inconnu' };
}

/** Semantic widget colour of a level. */
export function carbonLevelColor(level) {
  return CARBON_LEVEL_COLORS[level] ?? WIDGET_COLORS.NEUTRAL;
}
