// -----------------------------------------------------------------------------
// Device type: ELECTRICITY GRID (one per Electricity Maps zone)
//
// Read-only sensors refreshed by POLLING. The device is published WITHOUT a
// `poll_frequency`: the core only accepts a closed list of values capped at one
// minute, far too fast for an API refreshed hourly and metered monthly. The
// timer therefore lives in the integration (src/poller.js), which calls
// `onPoll` at the interval chosen by the user.
//
// Up to three values, all for the electricity actually CONSUMED in the zone:
//   - carbon intensity, in gCO2eq/kWh;
//   - carbon-free share (renewables + nuclear), in %;
//   - renewable share, in %.
//
// The first two come from the endpoint every plan serves; the renewable share
// needs the power breakdown, which the free "Home Assistant" access refuses
// (401). That endpoint is therefore PROBED once per token+zone, before the
// discovery payload is built (see `probeCapabilities`): a plan that refuses it
// gets a device with two sensors, instead of a third one that would read "no
// recent value" forever. The probe payload is reused by the poll that follows,
// so the check costs no extra request.
//
// Beyond the sensors, this device feeds the three surfaces Gladys 5.1 opened to
// external integrations: the dashboard WIDGET (src/widgets.js), the scene
// ACTION (src/scenes.js) and the scene TRIGGER `carbon_level_changed`, fired
// from here because this is where the values are read. All three share the last
// reading through src/gridSnapshot.js, so none of them costs an extra API
// request.
//
// The states published before the user actually creates the device are lost
// (Gladys has nowhere to store them yet), so the last batch is kept in memory
// and replayed by `onDeviceCreated`: the device shows its values immediately
// instead of waiting for the next tick of the refresh loop.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { isConfigured } from '../config.js';
import {
  GRAM_CO2EQ_PER_KILOWATT_HOUR,
  GRID_CARBON_SENSOR,
  GRID_CARBON_TYPES,
} from '../features.js';
import { fetchGridStatus, fetchPowerBreakdown } from '../electricityMaps.js';
import { rememberGridSnapshot } from '../gridSnapshot.js';
import { publishCarbonLevelEvent } from '../scenes.js';

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

  /**
   * External ids of the features the device publishes, for the surfaces that
   * bind to them without going through the discovery payload (the dashboard
   * widget). `renewable` is null while the plan refuses the power breakdown:
   * that feature is not published either, so nothing may point at it.
   */
  featureExternalIds(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, config.zone);
    return {
      carbonIntensity: ids.feature(FEATURE.CARBON_INTENSITY),
      carbonFree: ids.feature(FEATURE.CARBON_FREE),
      renewable: isPowerBreakdownAllowed(config) ? ids.feature(FEATURE.RENEWABLE) : null,
    };
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, config.zone);
    const features = [
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
    ];

    // The renewable share is only advertised while the plan may serve it: a
    // sensor no endpoint can fill would sit on the dashboard reading "no
    // recent value" for good.
    if (isPowerBreakdownAllowed(config)) {
      features.push({
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
      });
    }

    return {
      name: `Electricity Maps (${config.zone})`,
      external_id: ids.device,
      // No `poll_frequency` here on purpose: see the header, the refresh is
      // driven by src/poller.js.
      features,
    };
  },

  /**
   * Find out what the plan serves BEFORE the discovery payload is built, so
   * `buildDevice` knows whether the renewable sensor can ever hold a value.
   * One request, and only while the answer is unknown for this token+zone; its
   * payload is kept for the poll that follows, which therefore does not read
   * the same endpoint twice.
   */
  async probeCapabilities(gladys, config) {
    if (planFor(config).allowed !== null || !isConfigured(config)) {
      return;
    }
    logger.info('Checking whether your plan serves the power breakdown (renewable share)...');
    try {
      const breakdown = await fetchPowerBreakdown(config);
      rememberPowerBreakdownAllowed(config);
      rememberProbedBreakdown(config, breakdown);
    } catch (err) {
      rememberPowerBreakdownFailure(config, err);
    }
  },

  /**
   * What the device currently advertises, as a comparable string: the refresh
   * loop re-publishes the devices when it changes, which is how a plan refusal
   * discovered by a poll (rather than by the probe) still takes the renewable
   * sensor off the discovery list.
   */
  capabilitiesSignature(config) {
    return isPowerBreakdownAllowed(config) ? 'renewable' : 'no-renewable';
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
    // other, hence `allSettled`. When the capability probe just read the
    // breakdown, its payload is reused instead of paying for the same request
    // again seconds later.
    // ------------------------------------------------------------------ //
    const probed = takeProbedBreakdown(config);
    const reads = [fetchGridStatus(config)];
    if (!probed && isPowerBreakdownAllowed(config)) {
      reads.push(fetchPowerBreakdown(config));
    }
    const [status, polledBreakdown] = await Promise.allSettled(reads);
    const breakdown = probed ? { status: 'fulfilled', value: probed } : polledBreakdown;

    const states = [];
    // The same figures, kept aside for the widget, the scene action and the
    // scene trigger: they all read the last measurement instead of paying for
    // one of their own (see src/gridSnapshot.js).
    const values = {
      carbonIntensity: null,
      carbonFreePercentage: null,
      renewablePercentage: null,
    };

    if (status.status === 'fulfilled') {
      const { carbonIntensity, fossilFreePercentage, datetime } = status.value;
      // The hour of the value, to compare it with the right point of the
      // Electricity Maps site (hourly here, 15-minute points over there).
      const at = datetime ? ` (hourly value of ${datetime})` : '';
      logger.info(`Carbon intensity: ${carbonIntensity} gCO₂eq/kWh${at}`);
      logger.info(`Carbon-free: ${fossilFreePercentage}%`);
      values.carbonIntensity = carbonIntensity;
      values.carbonFreePercentage = fossilFreePercentage;
      pushState(states, ids.feature(FEATURE.CARBON_INTENSITY), carbonIntensity);
      pushState(states, ids.feature(FEATURE.CARBON_FREE), fossilFreePercentage);
    } else {
      logger.error('Grid status read failed', status.reason);
    }

    if (breakdown?.status === 'fulfilled') {
      const { fossilFreePercentage, renewablePercentage } = breakdown.value;
      logger.info(`Renewable: ${renewablePercentage}%`);
      // The plan does serve it: keep the sensor advertised.
      rememberPowerBreakdownAllowed(config);
      values.renewablePercentage = renewablePercentage;
      pushState(states, ids.feature(FEATURE.RENEWABLE), renewablePercentage);
      if (status.status !== 'fulfilled') {
        // The grid status is down but the breakdown carries the same share.
        values.carbonFreePercentage = fossilFreePercentage;
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
    rememberStates(config, states);

    // The states are safe: now tell the rest of the integration what was read,
    // and fire the scene trigger when the grid actually changed level. The
    // event is published AFTER the states so a scene reading the sensors right
    // away sees the values the event describes.
    const snapshot = rememberGridSnapshot(config, values);
    await publishCarbonLevelEvent(gladys, snapshot);
  },

  /**
   * The user just created the device from the discovery list. Its features are
   * empty until the next tick of the refresh loop, up to `poll_frequency`
   * away: publish something now. The states read by an earlier tick were sent
   * while the device did not exist yet, so Gladys dropped them; replaying that
   * batch costs no API request, and only a cache older than one refresh
   * interval is worth a live read.
   */
  async onDeviceCreated(gladys, config) {
    const cached = takeFreshStates(config);
    if (cached) {
      logger.info(`Device created: replaying the last known values for zone ${config.zone}`);
      await gladys.publishStates(cached);
      return;
    }
    logger.info(`Device created: reading Electricity Maps for zone ${config.zone}`);
    await this.onPoll(gladys, config);
  },
};

// Last batch published for a given token+zone, replayed on device creation.
let lastStates = { key: null, at: 0, states: null };

function rememberStates(config, states) {
  lastStates = { key: planKey(config), at: Date.now(), states };
}

/**
 * The cached batch when it is no older than one refresh interval (past that,
 * the loop would have replaced it anyway), otherwise null.
 */
function takeFreshStates(config) {
  if (lastStates.key !== planKey(config) || lastStates.states === null) {
    return null;
  }
  const ageSeconds = (Date.now() - lastStates.at) / 1000;
  return ageSeconds <= config.poll_frequency ? lastStates.states : null;
}

// What the plan does with the power breakdown, for one token+zone pair:
//   allowed === null  -> not asked yet (the sensor is advertised optimistically)
//   allowed === true  -> served
//   allowed === false -> refused (401/403): stop asking, and stop publishing
//                        the renewable sensor
// Plans that refuse it (the free "Home Assistant" access is one of them) answer
// 401/403 to every call, so a free key spends one request per poll instead of
// two. The decision is tied to the token+zone pair, so changing either gives
// the new plan a fresh try.
let powerBreakdownPlan = { key: null, allowed: null };

function planKey({ api_token: apiToken, zone }) {
  return `${zone} ${apiToken}`;
}

/** Plan state of this token+zone, reset as soon as either one changed. */
function planFor(config) {
  const key = planKey(config);
  if (powerBreakdownPlan.key !== key) {
    powerBreakdownPlan = { key, allowed: null };
  }
  return powerBreakdownPlan;
}

function isPowerBreakdownAllowed(config) {
  return planFor(config).allowed !== false;
}

function rememberPowerBreakdownAllowed(config) {
  planFor(config).allowed = true;
}

/**
 * A breakdown read failed: give up on that endpoint when the plan is the
 * reason (401/403), keep retrying on anything else (network, quota, 5xx).
 */
function rememberPowerBreakdownFailure(config, reason) {
  if (reason?.status === 401 || reason?.status === 403) {
    planFor(config).allowed = false;
    logger.info(
      'Your Electricity Maps plan does not serve the power breakdown: the renewable share ' +
        'sensor is not published, the carbon intensity and the carbon-free share keep working.',
    );
    return;
  }
  logger.error('Power breakdown read failed', reason);
}

// Breakdown read by `probeCapabilities`, handed over to the poll that follows.
// One-shot, and only while it is fresh: a value nobody consumed for a while is
// not what the sensor should show.
const PROBE_REUSE_MS = 60_000;
let probedBreakdown = { key: null, at: 0, value: null };

function rememberProbedBreakdown(config, value) {
  probedBreakdown = { key: planKey(config), at: Date.now(), value };
}

function takeProbedBreakdown(config) {
  if (probedBreakdown.value === null || probedBreakdown.key !== planKey(config)) {
    return null;
  }
  const fresh = Date.now() - probedBreakdown.at <= PROBE_REUSE_MS ? probedBreakdown.value : null;
  probedBreakdown = { key: null, at: 0, value: null };
  return fresh;
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
