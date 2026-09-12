// -----------------------------------------------------------------------------
// Device registry.
//
// Each device type lives in its own file and exposes the same shape:
//   - key                             : short identifier (used in logs)
//   - deviceExternalId(gladys, config): the device external_id (for dispatch)
//   - buildDevice(gladys, config)     : the discovery payload sent to Gladys
//   - onPoll(gladys, config)          : periodic read, called by Gladys at the
//     `poll_frequency` declared in the discovery payload
//   - actions (optional)              : manifest action handlers, keyed by the
//     action `key` declared in gladys-assistant-integration.json
//
// Electricity Maps exposes one grid per zone, so the catalog holds a single
// device type. Add a file here and register it below to publish more.
// -----------------------------------------------------------------------------

import { gridCarbon } from './gridCarbon.js';

export const DEVICE_BLUEPRINTS = [gridCarbon];

/**
 * Build the discovery payload for Gladys (all devices).
 */
export function buildDiscoveredDevices(gladys, config) {
  return DEVICE_BLUEPRINTS.map((bp) => bp.buildDevice(gladys, config));
}

/**
 * Find the blueprint that owns a given device, from its external_id (used to
 * route onPoll to the right device).
 */
export function findBlueprintByDevice(gladys, device, config) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.deviceExternalId(gladys, config) === device.external_id);
}
