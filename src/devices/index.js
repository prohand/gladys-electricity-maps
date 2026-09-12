// -----------------------------------------------------------------------------
// Device registry.
//
// Each device type lives in its own file and exposes the same shape:
//   - key                             : short identifier (used in logs)
//   - deviceExternalId(gladys, config): the device external_id (for dispatch)
//   - buildDevice(gladys, config)     : the discovery payload sent to Gladys
//   - onPoll(gladys, config)          : periodic read, called by the internal
//     refresh loop (src/poller.js) at the interval chosen by the user
//   - actions (optional)              : manifest action handlers, keyed by the
//     action `key` declared in gladys-assistant-integration.json
//   - probeCapabilities (optional)    : awaited before the discovery payload is
//     built, for a blueprint whose features depend on what the third party
//     actually serves
//   - capabilitiesSignature (optional): comparable string of what the device
//     advertises, so a change discovered later triggers a re-publication
//
// Electricity Maps exposes one grid per zone, so the catalog holds a single
// device type. Add a file here and register it below to publish more.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isConfigured } from '../config.js';
import { toUnknownFeatures } from '../features.js';
import { gridCarbon } from './gridCarbon.js';

export const DEVICE_BLUEPRINTS = [gridCarbon];

const logger = createLogger({ name: 'devices' });

// Set once the core has refused the `grid-carbon-sensor` category: it will
// refuse it on every publish, so we stop sending it (see publishDevices).
let unknownFeaturesFallback = false;

/**
 * Build the discovery payload for Gladys (all devices).
 */
export function buildDiscoveredDevices(gladys, config) {
  const devices = DEVICE_BLUEPRINTS.map((bp) => bp.buildDevice(gladys, config));
  return unknownFeaturesFallback ? devices.map(toUnknownFeatures) : devices;
}

/**
 * Publish the discovery payload, falling back to the generic UNKNOWN features
 * on a core that does not know the `grid-carbon-sensor` category yet: it
 * rejects the WHOLE payload with a 400, which would leave the user with no
 * device at all rather than with badly labelled ones. The decision is taken
 * once and kept for the process lifetime.
 *
 * Nothing is published while the configuration is incomplete: without a token
 * the device could never hold a single value, and offering it in the Discovery
 * screen only gets it created with sensors stuck on "no recent value". The
 * devices appear as soon as the token is saved (onConfigUpdated re-publishes).
 * @param {object} gladys SDK instance
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} config
 * @returns {Promise<boolean>} whether the payload was published
 */
export async function publishDevices(gladys, config) {
  if (!isConfigured(config)) {
    logger.warn('Discovery skipped: no API token or zone configured yet');
    return false;
  }
  await probeCapabilities(gladys, config);
  try {
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
    return true;
  } catch (err) {
    if (unknownFeaturesFallback || !isUnknownFeatureError(err)) {
      throw err;
    }
    logger.warn(
      `This Gladys version does not know the grid carbon sensors yet (${err.message}): ` +
        'publishing them as generic sensors instead. Update Gladys to get their real ' +
        'names, icons and units.',
    );
    unknownFeaturesFallback = true;
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
    return true;
  }
}

/**
 * Let every blueprint find out what the third party serves before its
 * discovery payload is built: a feature nothing can ever fill is better left
 * unpublished than shown empty forever. A failing probe must not keep the
 * devices from being published: the blueprint then advertises what it assumes
 * it can read, and a later poll settles the question (see
 * `capabilitiesSignature`).
 */
async function probeCapabilities(gladys, config) {
  for (const bp of DEVICE_BLUEPRINTS) {
    if (!bp.probeCapabilities) {
      continue;
    }
    try {
      await bp.probeCapabilities(gladys, config);
    } catch (err) {
      logger.error(`Capability probe of ${bp.key} failed`, err);
    }
  }
}

/**
 * What the whole catalog advertises right now, as a comparable string. The
 * refresh loop compares it around each tick: a poll that discovers the plan
 * refuses an endpoint changes it, and the devices are re-published without the
 * feature that endpoint was feeding.
 */
export function capabilitiesSignature(config) {
  return DEVICE_BLUEPRINTS.map(
    (bp) => `${bp.key}=${bp.capabilitiesSignature?.(config) ?? ''}`,
  ).join('|');
}

/**
 * A core older than the category answers `400 devices[0].features[0].category:
 * unknown category` (same wording for an unknown type or unit). Anything else
 * (auth, network, a real payload bug) must keep bubbling up.
 */
function isUnknownFeatureError(err) {
  return err?.status === 400 && /unknown (category|type|unit)/i.test(err.message ?? '');
}

/**
 * Find the blueprint that owns a given device, from its external_id (used to
 * route onPoll to the right device).
 */
export function findBlueprintByDevice(gladys, device, config) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.deviceExternalId(gladys, config) === device.external_id);
}
