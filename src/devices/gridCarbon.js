// -----------------------------------------------------------------------------
// Device type: ELECTRICITY GRID (one per Electricity Maps zone)
//
// Read-only sensors refreshed by POLLING. The device is published WITHOUT a
// `poll_frequency`: the core only accepts a closed list of values capped at one
// minute, far too fast for an API refreshed hourly and metered monthly. The
// timer therefore lives in the integration (src/poller.js), which calls
// `onPoll` at the interval chosen by the user.
//
// Three values, all for the electricity actually CONSUMED in the zone:
//   - carbon intensity, in gCO2eq/kWh;
//   - carbon-free share (renewables + nuclear), in %;
//   - renewable share, in %.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchCarbonIntensity, fetchPowerBreakdown } from '../electricityMaps.js';

const DEVICE_TYPE = 'grid-carbon';

// Named logger from the SDK: every line is prefixed with [grid-carbon].
const logger = createLogger({ name: DEVICE_TYPE });

// Feature keys, kept in one place so discovery and polling always agree.
const FEATURE = {
  CARBON_INTENSITY: 'carbon-intensity',
  CARBON_FREE: 'carbon-free-percentage',
  RENEWABLE: 'renewable-percentage',
};

// Upper bound of the carbon intensity gauge. The dirtiest zones sit around
// 900 gCO2eq/kWh; 1500 leaves room without flattening the usual range.
const MAX_CARBON_INTENSITY = 1500;

export const gridCarbon = {
  key: DEVICE_TYPE,

  // The zone IS the unique, stable id of the observed "device" on the
  // Electricity Maps side: changing the zone in the configuration therefore
  // yields a different device, which is the expected behaviour.
  deviceExternalId(gladys, config) {
    return gladys.externalIds(DEVICE_TYPE, config.zone).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, config.zone);
    return {
      name: `Electricity Maps (${config.zone})`,
      external_id: ids.device,
      // No `poll_frequency` here on purpose: see the header, the refresh is
      // driven by src/poller.js.
      features: [
        {
          // No standard Gladys unit exists for gCO2eq/kWh, so the unit lives in
          // the feature name and the category stays the generic one.
          name: 'Carbon intensity (gCO₂eq/kWh)',
          external_id: ids.feature(FEATURE.CARBON_INTENSITY),
          category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
          type: DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
          min: 0,
          max: MAX_CARBON_INTENSITY,
          read_only: true, // sensor: nothing to command
          has_feedback: false,
          keep_history: true, // keep history to draw charts
        },
        {
          name: 'Carbon-free electricity',
          external_id: ids.feature(FEATURE.CARBON_FREE),
          category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
          type: DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
          unit: DEVICE_FEATURE_UNITS.PERCENT,
          min: 0,
          max: 100,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Renewable electricity',
          external_id: ids.feature(FEATURE.RENEWABLE),
          category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
          type: DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
          unit: DEVICE_FEATURE_UNITS.PERCENT,
          min: 0,
          max: 100,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  // Manifest actions owned by this device type (see the `actions` field of
  // `gladys-assistant-integration.json`). The resolved multi-language message
  // is displayed under the button, and a thrown error is displayed too.
  actions: {
    async test_connection(gladys, { config }) {
      logger.info('Action test_connection -> live request to Electricity Maps');
      const { carbonIntensity } = await fetchCarbonIntensity(config);
      return {
        en: `Connected: ${carbonIntensity} gCO₂eq/kWh in zone ${config.zone} right now.`,
        fr: `Connexion OK : ${carbonIntensity} gCO₂eq/kWh dans la zone ${config.zone} actuellement.`,
      };
    },
  },

  async onPoll(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, config.zone);
    logger.info(`Polling Electricity Maps for zone ${config.zone}...`);

    // ------------------------------------------------------------------ //
    // DO THE WORK: read the two endpoints.
    // They are independent: some plans or zones serve the carbon intensity
    // but not the power breakdown, so one failure must not lose the other.
    // ------------------------------------------------------------------ //
    const [intensity, breakdown] = await Promise.allSettled([
      fetchCarbonIntensity(config),
      fetchPowerBreakdown(config),
    ]);

    const states = [];

    if (intensity.status === 'fulfilled') {
      const { carbonIntensity, isEstimated } = intensity.value;
      logger.info(
        `Carbon intensity: ${carbonIntensity} gCO₂eq/kWh${isEstimated ? ' (estimated)' : ''}`,
      );
      pushState(states, ids.feature(FEATURE.CARBON_INTENSITY), carbonIntensity);
    } else {
      logger.error('Carbon intensity read failed', intensity.reason);
    }

    if (breakdown.status === 'fulfilled') {
      const { fossilFreePercentage, renewablePercentage } = breakdown.value;
      logger.info(`Carbon-free: ${fossilFreePercentage}% / renewable: ${renewablePercentage}%`);
      pushState(states, ids.feature(FEATURE.CARBON_FREE), fossilFreePercentage);
      pushState(states, ids.feature(FEATURE.RENEWABLE), renewablePercentage);
    } else {
      logger.error('Power breakdown read failed', breakdown.reason);
    }

    if (states.length === 0) {
      // Nothing readable at all: propagate so the caller can report the
      // integration as disconnected instead of pretending everything is fine.
      throw (
        intensity.reason ?? breakdown.reason ?? new Error('No data returned by Electricity Maps')
      );
    }

    // Publish every value in a single request (batch, up to 100).
    await gladys.publishStates(states);
  },
};

/**
 * Queue a state, skipping the values the API did not provide: publishing a
 * `null` would write a bogus 0 in the history.
 */
function pushState(states, featureExternalId, value) {
  if (value === null || value === undefined) {
    return;
  }
  states.push({ device_feature_external_id: featureExternalId, state: value });
}
