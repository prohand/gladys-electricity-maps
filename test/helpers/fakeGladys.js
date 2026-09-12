// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId)  -> { device, feature(key) }
//   - publishState / publishStates    -> record calls so tests can assert them
//   - publishDiscoveredDevices        -> record every attempt, and let a test
//     make it fail (the core refusing an unknown feature category)
//   - setConnectionStatus             -> record calls so tests can assert them
// This lets us test the pure "wiring" logic (discovery payloads, dispatch,
// polling) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {Function} [options.onPublishDevices] called with (devices, attemptIndex)
 *   on each publishDiscoveredDevices: throw from it to simulate a core refusing
 *   the payload.
 */
export function createFakeGladys({ onPublishDevices } = {}) {
  const published = [];
  const connectionStatuses = [];
  // One entry per publishDiscoveredDevices call, failed attempts included.
  const publishedDevices = [];

  return {
    published,
    connectionStatuses,
    publishedDevices,

    async publishDiscoveredDevices(devices) {
      publishedDevices.push(devices);
      if (onPublishDevices) {
        await onPublishDevices(devices, publishedDevices.length - 1);
      }
    },

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
