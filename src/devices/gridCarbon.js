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
//
// The first two come from the endpoint every plan serves; the renewable share
// needs the power breakdown, which the free "Home Assistant" access refuses
// (401). It is therefore tried once per token+zone and then dropped, so a free
// key does not burn a request per poll on an endpoint it may not call.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import {
  GRAM_CO2EQ_PER_KILOWATT_HOUR,
  GRID_CARBON_SENSOR,
  GRID_CARBON_TYPES,
} from '../features.js';
import { fetchGridStatus, fetchPowerBreakdown } from '../electricityMaps.js';

const DEVICE_TYPE = 'grid-carbon';

// Named logger from the SDK: every line is prefixed with [grid-carbon].
const logger = createLogger({ name: DEVICE_TYPE });

// Feature keys, kept in one place so discovery and polling always agree. They
// are the core's own type names: one sensor per type, so the external_id stays
// readable in the logs and in the Gladys UI.
const FEATURE = {
  CARBON_INTENSITY: GRID_CARBON_TYPES.CARBON_INTENSITY,
  CARBON_FREE: GRID_CARBON_TYPES.CARBON_FREE_PERCENTAGE,
  RENEWABLE: GRID_CARBON_TYPES.RENEWABLE_PERCENTAGE,
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
          // The unit is declared, not written in the name: Gladys renders it
          // next to the value (57 gCO₂eq/kWh).
          name: 'Carbon intensity',
          external_id: ids.feature(FEATURE.CARBON_INTENSITY),
          category: GRID_CARBON_SENSOR,
          type: GRID_CARBON_TYPES.CARBON_INTENSITY,
          unit: GRAM_CO2EQ_PER_KILOWATT_HOUR,
          min: 0,
          max: MAX_CARBON_INTENSITY,
          read_only: true, // sensor: nothing to command
          has_feedback: false,
          keep_history: true, // keep history to draw charts
        },
        {
          name: 'Carbon-free electricity',
          external_id: ids.feature(FEATURE.CARBON_FREE),
          category: GRID_CARBON_SENSOR,
          type: GRID_CARBON_TYPES.CARBON_FREE_PERCENTAGE,
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
          category: GRID_CARBON_SENSOR,
          type: GRID_CARBON_TYPES.RENEWABLE_PERCENTAGE,
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
      const { carbonIntensity } = await fetchGridStatus(config);
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
    // DO THE WORK: read the grid status, plus the power breakdown as long as
    // the plan serves it. They are independent: one failure must not lose the
    // other, hence `allSettled`.
    // ------------------------------------------------------------------ //
    const reads = [fetchGridStatus(config)];
    if (isPowerBreakdownAllowed(config)) {
      reads.push(fetchPowerBreakdown(config));
    }
    const [status, breakdown] = await Promise.allSettled(reads);

    const states = [];

    if (status.status === 'fulfilled') {
      const { carbonIntensity, fossilFreePercentage } = status.value;
      logger.info(`Carbon intensity: ${carbonIntensity} gCO₂eq/kWh`);
      logger.info(`Carbon-free: ${fossilFreePercentage}%`);
      pushState(states, ids.feature(FEATURE.CARBON_INTENSITY), carbonIntensity);
      pushState(states, ids.feature(FEATURE.CARBON_FREE), fossilFreePercentage);
    } else {
      logger.error('Grid status read failed', status.reason);
    }

    if (breakdown?.status === 'fulfilled') {
      const { fossilFreePercentage, renewablePercentage } = breakdown.value;
      logger.info(`Renewable: ${renewablePercentage}%`);
      pushState(states, ids.feature(FEATURE.RENEWABLE), renewablePercentage);
      if (status.status !== 'fulfilled') {
        // The grid status is down but the breakdown carries the same share.
        pushState(states, ids.feature(FEATURE.CARBON_FREE), fossilFreePercentage);
      }
    } else if (breakdown) {
      rememberPowerBreakdownFailure(config, breakdown.reason);
    }

    if (states.length === 0) {
      // Nothing readable at all: propagate so the caller can report the
      // integration as disconnected instead of pretending everything is fine.
      throw status.reason ?? breakdown?.reason ?? new Error('No data returned by Electricity Maps');
    }

    // Publish every value in a single request (batch, up to 100).
    await gladys.publishStates(states);
  },
};

// Plans that refuse the power breakdown (the free "Home Assistant" access is
// one of them) answer 401/403 to every call: remember it and stop asking, so a
// free key spends one request per poll instead of two. The decision is tied to
// the token+zone pair, so changing either gives the new plan a fresh try.
let powerBreakdownPlan = { key: null, allowed: true };

function planKey({ api_token: apiToken, zone }) {
  return `${zone}\u0000${apiToken}`;
}

function isPowerBreakdownAllowed(config) {
  const key = planKey(config);
  if (powerBreakdownPlan.key !== key) {
    powerBreakdownPlan = { key, allowed: true };
  }
  return powerBreakdownPlan.allowed;
}

/**
 * A breakdown read failed: give up on that endpoint when the plan is the
 * reason (401/403), keep retrying on anything else (network, quota, 5xx).
 */
function rememberPowerBreakdownFailure(config, reason) {
  if (reason?.status === 401 || reason?.status === 403) {
    powerBreakdownPlan = { key: planKey(config), allowed: false };
    logger.info(
      'Your Electricity Maps plan does not serve the power breakdown: the renewable share ' +
        'stays empty, the carbon intensity and the carbon-free share keep working.',
    );
    return;
  }
  logger.error('Power breakdown read failed', reason);
}

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
