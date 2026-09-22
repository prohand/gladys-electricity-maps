// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId)  -> { device, feature(key) }
//   - publishState / publishStates    -> record calls so tests can assert them
//   - publishDiscoveredDevices        -> record every attempt, and let a test
//     make it fail (the core refusing an unknown feature category)
//   - setConnectionStatus             -> record calls so tests can assert them
//   - publishSceneEvent               -> record the scene trigger events
//   - requestWidgetRefresh            -> record the widget freshness nudges
//   - devices / getDevices            -> what the user actually created, which
//     is what the widget binds its tiles and its chart to
// This lets us test the pure "wiring" logic (discovery payloads, dispatch,
// polling, widget contents, scene events) without a running Gladys server or a
// real WebSocket.
// -----------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {Function} [options.onPublishDevices] called with (devices, attemptIndex)
 *   on each publishDiscoveredDevices: throw from it to simulate a core refusing
 *   the payload.
 * @param {Array} [options.devices] devices the user created, as the SDK exposes
 *   them (`gladys.devices`): `[{ external_id }]`.
 * @param {Function} [options.onPublishSceneEvent] called with (key, data) on
 *   each publishSceneEvent: throw from it to simulate a core refusing it.
 */
export function createFakeGladys({ onPublishDevices, devices = [], onPublishSceneEvent } = {}) {
  const published = [];
  const connectionStatuses = [];
  // One entry per publishDiscoveredDevices call, failed attempts included.
  const publishedDevices = [];
  const sceneEvents = [];
  const widgetRefreshes = [];

  return {
    published,
    connectionStatuses,
    publishedDevices,
    sceneEvents,
    widgetRefreshes,
    devices,

    async publishDiscoveredDevices(discovered) {
      publishedDevices.push(discovered);
      if (onPublishDevices) {
        await onPublishDevices(discovered, publishedDevices.length - 1);
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

    async publishSceneEvent(key, data) {
      if (onPublishSceneEvent) {
        await onPublishSceneEvent(key, data);
      }
      sceneEvents.push({ key, data });
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },

    async getDevices() {
      return devices;
    },
  };
}
