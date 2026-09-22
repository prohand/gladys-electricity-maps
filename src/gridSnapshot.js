// -----------------------------------------------------------------------------
// Last known reading of the grid, in memory.
//
// The poll publishes its values as device states, and Gladys keeps their
// history — but three other surfaces need the SAME reading without spending an
// API request on it:
//   - the `carbon_level_changed` scene trigger, which compares the level with
//     the previous one (src/scenes.js builds the event, src/devices/gridCarbon.js
//     fires it);
//   - the dashboard widget, which shows the zone, the level and the age of the
//     reading next to the live tiles (src/widgets.js);
//   - the `get_grid_data` scene action, which hands the values to the rest of
//     the scene (src/scenes.js).
//
// It is deliberately NOT a cache of the API: nothing here ever avoids a poll,
// it only lets several readers share the one the loop already did. A free
// Electricity Maps key has a monthly quota, so a value read once is a value
// worth reading once.
//
// The snapshot is tied to the token+zone pair, like everything else in this
// integration: changing either gives a different grid, and the previous level
// must not leak into it (a level change from zone FR to zone DE is not a
// transition, it is a different subject).
// -----------------------------------------------------------------------------

import { classifyCarbonIntensity } from './carbonLevel.js';

/** @typedef {{ zone: string, level: string|null, previousLevel: string|null, at: number, valueAt: number|null, carbonIntensity: number|null, carbonFreePercentage: number|null, renewablePercentage: number|null }} GridSnapshot */

let snapshot = null;
let snapshotKey = null;

/** Token+zone pair: what makes two readings comparable. */
function keyOf({ api_token: apiToken, zone }) {
  return `${zone} ${apiToken}`;
}

/**
 * Record what a poll just read, and derive the carbon level from it.
 *
 * The level is classified against the PREVIOUS one, which is what gives the
 * bands their hysteresis (see src/carbonLevel.js). A read that came back
 * without a carbon intensity (the grid status endpoint failed while the power
 * breakdown answered) keeps the level it had: the level did not become
 * unknown, we just did not measure it this time.
 *
 * `at` is when the poll ran, `valueAt` the hour the figures belong to, as the
 * API dates them (null when it sends no date). They differ: the API serves
 * HOURLY values, so a poll at 20:47 reads the value of the 20:00 hour.
 *
 * @param {{ api_token: string, zone: string }} config
 * @param {{ carbonIntensity: number|null, carbonFreePercentage: number|null, renewablePercentage: number|null, datetime?: string|null }} values
 * @returns {GridSnapshot} the snapshot just stored
 */
export function rememberGridSnapshot(config, values) {
  const key = keyOf(config);
  const previous = snapshotKey === key ? snapshot : null;
  const previousLevel = previous?.level ?? null;
  const level = classifyCarbonIntensity(values.carbonIntensity, previousLevel) ?? previousLevel;

  snapshotKey = key;
  snapshot = {
    zone: config.zone,
    level,
    previousLevel,
    at: Date.now(),
    valueAt: toTimestamp(values.datetime),
    carbonIntensity: values.carbonIntensity ?? null,
    carbonFreePercentage: values.carbonFreePercentage ?? null,
    renewablePercentage: values.renewablePercentage ?? null,
  };
  return snapshot;
}

/**
 * The last reading of this token+zone pair, or null when none was taken yet
 * (startup, or the user just changed the zone).
 * @param {{ api_token: string, zone: string }} config
 * @returns {GridSnapshot|null}
 */
export function readGridSnapshot(config) {
  return snapshotKey === keyOf(config) ? snapshot : null;
}

/** How old a snapshot is, in whole seconds. */
export function gridSnapshotAgeSeconds({ at }) {
  return Math.max(0, Math.round((Date.now() - at) / 1000));
}

/** An ISO date as a timestamp, or null when missing or unreadable. */
function toTimestamp(datetime) {
  const time = datetime ? new Date(datetime).getTime() : NaN;
  return Number.isNaN(time) ? null : time;
}

/** Forget everything: only used to isolate the tests from one another. */
export function resetGridSnapshot() {
  snapshot = null;
  snapshotKey = null;
}
