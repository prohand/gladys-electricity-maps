// -----------------------------------------------------------------------------
// Gladys feature constants used by this integration.
//
// The grid carbon sensors have their own category in the Gladys core,
// `grid-carbon-sensor`, with three types (`carbon-intensity`,
// `carbon-free-percentage`, `renewable-percentage`) and a dedicated unit
// (`gram-co2eq-per-kilowatt-hour`). Declaring them is what makes Gladys name,
// group and chart the sensors instead of showing them as "Unknown".
//
// They come from the SDK constants (a verbatim mirror of the core's
// `DEVICE_FEATURE_*`), never from hand-written strings: a typo would only show
// up as a refused discovery payload.
//
// A core that does NOT know the category answers `400 unknown category` and
// rejects the whole discovery payload, so src/devices/index.js falls back to
// the generic UNKNOWN feature (see `toUnknownFeatures`): the sensors then read
// as "Unknown" in the UI, but they do show up. Every core the manifest accepts
// (>= 5.3.0) knows the category; the fallback stays as a safety net, since the
// Gladys version range is a catalog filter, not a guarantee.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const GRID_CARBON_SENSOR = DEVICE_FEATURE_CATEGORIES.GRID_CARBON_SENSOR;

export const GRID_CARBON_TYPES = DEVICE_FEATURE_TYPES.GRID_CARBON_SENSOR;

export const GRAM_CO2EQ_PER_KILOWATT_HOUR = DEVICE_FEATURE_UNITS.GRAM_CO2_EQ_PER_KILOWATT_HOUR;

// Units that only exist alongside the category: a core refusing the category
// refuses them too, so the downgrade has to drop them.
const GRID_CARBON_ONLY_UNITS = new Map([[GRAM_CO2EQ_PER_KILOWATT_HOUR, 'gCO₂eq/kWh']]);

/**
 * Rewrite a discovery payload for a core that does not know the grid carbon
 * category: every feature becomes the generic UNKNOWN sensor, and a unit that
 * disappears with the category moves into the feature name so the value stays
 * readable.
 * @param {object} device discovery payload built by a blueprint
 * @returns {object} the same payload, with UNKNOWN features
 */
export function toUnknownFeatures(device) {
  return {
    ...device,
    features: device.features.map((feature) => {
      const downgraded = {
        ...feature,
        category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
        type: DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
      };
      const droppedUnit = GRID_CARBON_ONLY_UNITS.get(downgraded.unit);
      if (droppedUnit) {
        delete downgraded.unit;
        downgraded.name = `${feature.name} (${droppedUnit})`;
      }
      return downgraded;
    }),
  };
}
