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
//
// Electricity Maps exposes one grid per zone, so the catalog holds a single
// device type. Add a file here and register it below to publish more.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
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
 * @param {object} gladys SDK instance
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} config
 */
export async function publishDevices(gladys, config) {
  try {
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
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
  }
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
