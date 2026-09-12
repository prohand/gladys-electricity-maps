// -----------------------------------------------------------------------------
// Entry point of the Electricity Maps integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It
// holds NO API logic: the calls live in src/electricityMaps.js and the device
// logic in src/devices/gridCarbon.js. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigured } from './src/config.js';
import { createPoller } from './src/poller.js';
import { DEVICE_BLUEPRINTS, publishDevices, findBlueprintByDevice } from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Refresh loop owned by the integration (see src/poller.js for why Gladys does
// not drive it here).
const poller = createPoller(refreshAllDevices);

const NOT_CONFIGURED_MESSAGE = {
  en: 'Set your Electricity Maps API token and zone in the configuration.',
  fr: 'Renseignez votre token API Electricity Maps et votre zone dans la configuration.',
};

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered devices');
  await publishDevices(gladys, config);
});

// --- Polling: refresh a device -----------------------------------------------
// Devices are published without a `poll_frequency` (the core caps it at one
// minute, see src/poller.js), so the ticks come from our own loop. The handler
// stays registered anyway: it costs nothing and answers a refresh Gladys may
// ask for on its own.
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    // Typically a device created for a zone the user has since changed.
    logger.warn(`onPoll ignored: ${device.external_id} does not match zone ${config.zone}`);
    return;
  }
  await blueprint.onPoll(gladys, config);
});

/**
 * One tick of the refresh loop: read every device type in turn. A blueprint
 * failing must not skip the next one, so each is awaited on its own.
 */
async function refreshAllDevices() {
  if (!isConfigured(config)) {
    logger.warn('Refresh skipped: no API token or zone configured yet');
    return;
  }
  if (!gladys.connected) {
    // Gladys is unreachable: the states would be lost anyway, so do not spend
    // an Electricity Maps request on them.
    logger.warn('Refresh skipped: not connected to Gladys');
    return;
  }
  for (const blueprint of DEVICE_BLUEPRINTS) {
    try {
      await blueprint.onPoll(gladys, config);
    } catch (err) {
      logger.error(`Refresh of ${blueprint.key} failed`, err);
    }
  }
}

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the `actions` field of the manifest is registered per
// key; the message resolved by the handler is displayed under the button (the
// ack is awaited under the action's `timeout_seconds`, not the usual 5 s).
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // Re-publish the devices: the zone lives in the discovery payload, and
  // publishing is idempotent (upsert by external_id).
  await publishDevices(gladys, config);
  await reportConfigurationStatus();
  // Apply the new refresh interval (and read the new zone/token right away).
  poller.sync(config.poll_frequency);
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: no need to log it again
// here, this handler only runs the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) (Re)publish the devices as soon as we are connected.
    await publishDevices(gladys, config);

    // 3) Report the application-level status, shown in the Configuration
    // screen. Distinct from the container state machine: an integration can be
    // RUNNING and still unable to reach its third-party service.
    await reportConfigurationStatus();

    // 4) Start (or keep) the refresh loop. `sync` is a no-op when the interval
    // has not changed, so a reconnection never triggers an extra API call.
    poller.sync(config.poll_frequency);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

/**
 * Tell the user whether the integration can actually work: without a token and
 * a zone every poll would fail with the same 401, which is not something to
 * discover in the logs.
 */
async function reportConfigurationStatus() {
  if (!isConfigured(config)) {
    logger.warn('No API token or zone configured yet');
    await gladys.setConnectionStatus(false, NOT_CONFIGURED_MESSAGE);
    return;
  }
  await gladys.setConnectionStatus(true);
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  poller.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Electricity Maps integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
