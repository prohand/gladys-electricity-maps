// -----------------------------------------------------------------------------
// Dashboard widget: ONE card summarizing the grid of the followed zone.
//
// Declared in the `widgets` field of the manifest; the content itself is built
// here at runtime, in the core's declarative vocabulary (no HTML, no CSS: the
// core owns the theme, the dark mode and the responsiveness).
//
// The chart is `device_features`-bound, so it draws the history Gladys already
// keeps — an integration has no business re-sending 24 hours of points it
// published one by one. Everything else the card shows is carried by the
// content itself: the zone, the carbon LEVEL (a reading of the intensity, see
// src/carbonLevel.js), how old the last reading is, and the three figures.
//
// WHY THE TILES ARE NOT DEVICE-BOUND. A `device_feature` tile renders the
// published state through the core's own value component, which ignores the
// `color` the content declares: the figure is always drawn in the default ink.
// A tile that carries its own `value` IS coloured, so the number is green,
// orange or red like the badges of the device list — which is the whole point
// of colouring a tile. Nothing is lost by dropping the live binding: the
// figures only move when the poll loop reads Electricity Maps, and that loop
// nudges the widget (`requestWidgetRefresh`, see index.js) right after every
// reading, so the card is re-pulled at the exact moment a value changes.
//
// The device may not exist though: the widget can be added to a dashboard
// before the device is created in the Discovery screen, and the configuration
// may still be empty. Rather than an empty card, each of those states gets a
// content that says what to do — the figures are shown either way.
//
// No `settings` are declared: the integration follows ONE zone, the one in its
// configuration, so there is nothing to pick per instance. Adding a zone
// selector would mean publishing several devices first.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { isConfigured } from './config.js';
import { carbonLevelColor, carbonLevelLabel } from './carbonLevel.js';
import { gridSnapshotAgeSeconds, readGridSnapshot } from './gridSnapshot.js';
import { gridCarbon } from './devices/gridCarbon.js';

const logger = createLogger({ name: 'widgets' });

/** Widget keys, as declared in the manifest. */
export const WIDGET_KEYS = {
  GRID_CARBON: 'grid_carbon',
};

// Button action keys of the grid carbon widget. They live in the content, not
// in the manifest: the core relays exactly what the last content declared.
const REFRESH_ACTION = 'refresh';

// The live Electricity Maps map, deep-linked on the followed zone.
const MAP_URL = 'https://app.electricitymaps.com/zone';

// Unit shown on the carbon intensity tile. The real unit (gCO₂eq/kWh) is
// longer than the 6 characters a tile unit may hold, and the core truncates
// what overflows: the short form is the one that reads.
const SHORT_CARBON_UNIT = 'g/kWh';

/**
 * Registry of the dashboard widgets, keyed by the manifest widget key. Each
 * entry exposes:
 *   - `get(gladys, { config })`                        -> the content to render
 *   - `action(gladys, { actionKey, config, refresh })` -> a tapped button
 */
export const WIDGETS = {
  [WIDGET_KEYS.GRID_CARBON]: {
    async get(gladys, { config }) {
      return buildGridCarbonContent(gladys, config);
    },

    async action(gladys, { actionKey, config, refresh }) {
      if (actionKey !== REFRESH_ACTION) {
        logger.warn(`Unknown widget action "${actionKey}", ignored`);
        return undefined;
      }
      logger.info('Widget action refresh -> live read of Electricity Maps');
      await refresh();
      const snapshot = readGridSnapshot(config);
      if (snapshot === null) {
        throw new Error(`No Electricity Maps reading available for zone ${config.zone}`);
      }
      return {
        en: `${snapshot.carbonIntensity} gCO₂eq/kWh in zone ${snapshot.zone}.`,
        fr: `${snapshot.carbonIntensity} gCO₂eq/kWh dans la zone ${snapshot.zone}.`,
      };
    },
  },
};

/**
 * Build the content of the grid carbon card for the current state of the
 * integration. Always resolves a valid content: an empty or explanatory card
 * is a legitimate state, an error would only leave the dashboard blank.
 */
async function buildGridCarbonContent(gladys, config) {
  const ttlSeconds = contentTtl(config);

  if (!isConfigured(config)) {
    return {
      ttl_seconds: ttlSeconds,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: {
            en: 'Set your Electricity Maps API token and zone in the integration configuration.',
            fr: "Renseignez votre token API Electricity Maps et votre zone dans la configuration de l'intégration.",
          },
        },
      ],
    };
  }

  const snapshot = readGridSnapshot(config);
  if (snapshot === null) {
    return {
      ttl_seconds: ttlSeconds,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: {
            en: `No reading of zone ${config.zone} yet. The next refresh will fill this card.`,
            fr: `Aucune mesure de la zone ${config.zone} pour l'instant. Le prochain rafraîchissement remplira cette carte.`,
          },
        },
        refreshButton(),
        mapButton(config),
      ],
    };
  }

  const deviceCreated = await isDeviceCreated(gladys, gridCarbon.deviceExternalId(gladys, config));

  // Content order matters: the core drops what overflows the budget in the
  // order it was sent, so the status and the tiles come before the chart and
  // the buttons.
  const components = [statusComponent(snapshot), ...valueTiles(snapshot)];

  if (deviceCreated) {
    const features = gridCarbon.featureExternalIds(gladys, config);
    components.push({
      type: 'chart',
      device_features: [features.carbonIntensity],
      interval: 'last-day',
      chart_type: 'area',
      title: { en: 'Carbon intensity (24 h)', fr: 'Intensité carbone (24 h)' },
    });
  } else {
    // The device is not created yet: no history to chart. Say where it comes
    // from — the figures themselves are already on the tiles.
    components.push({
      type: 'text',
      variant: 'body',
      text: {
        en: 'Add the Electricity Maps device from the Discovery screen to get the history chart here.',
        fr: "Ajoutez l'appareil Electricity Maps depuis l'écran Découverte pour obtenir ici le graphique d'historique.",
      },
    });
  }

  components.push(refreshButton(), mapButton(config));
  return { ttl_seconds: ttlSeconds, components };
}

/** Zone, carbon level and freshness: the three things no device feature holds. */
function statusComponent(snapshot) {
  return {
    type: 'status',
    items: [
      { label: { en: 'Zone', fr: 'Zone' }, value: snapshot.zone, icon: 'map-pin' },
      {
        label: { en: 'Carbon level', fr: 'Niveau carbone' },
        value: carbonLevelLabel(snapshot.level),
        color: carbonLevelColor(snapshot.level),
        icon: 'activity',
      },
      {
        label: { en: 'Last reading', fr: 'Dernière mesure' },
        value: formatAge(gridSnapshotAgeSeconds(snapshot)),
        icon: 'clock',
      },
    ],
  };
}

/** The three figures of the reading, each coloured by what it says. */
function valueTiles(snapshot) {
  const tiles = [];
  if (snapshot.carbonIntensity !== null) {
    tiles.push({
      type: 'value',
      label: carbonIntensityLabel(),
      icon: 'cloud',
      value: snapshot.carbonIntensity,
      unit: SHORT_CARBON_UNIT,
      color: carbonLevelColor(snapshot.level),
    });
  }
  if (snapshot.carbonFreePercentage !== null) {
    tiles.push({
      type: 'value',
      label: carbonFreeLabel(),
      icon: 'sun',
      value: snapshot.carbonFreePercentage,
      unit: '%',
      color: cleanShareColor(snapshot.carbonFreePercentage),
    });
  }
  if (snapshot.renewablePercentage !== null) {
    tiles.push({
      type: 'value',
      label: renewableLabel(),
      icon: 'wind',
      value: snapshot.renewablePercentage,
      unit: '%',
      color: cleanShareColor(snapshot.renewablePercentage),
    });
  }
  return tiles;
}

function refreshButton() {
  return {
    type: 'button',
    label: { en: 'Refresh', fr: 'Actualiser' },
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: REFRESH_ACTION },
  };
}

function mapButton(config) {
  return {
    type: 'button',
    label: { en: 'Live map', fr: 'Carte en direct' },
    icon: 'external-link',
    style: 'secondary',
    link: { url: `${MAP_URL}/${encodeURIComponent(config.zone)}` },
  };
}

// -----------------------------------------------------------------------------
// Tile colours.
//
// A tile carries a SEMANTIC colour, which the core maps to its theme in light
// and dark mode — never a hex value. The carbon intensity reuses the colour of
// its band (src/carbonLevel.js), so the tile, the status dot and the scene
// trigger tell the same story.
//
// The two percentages are read the other way round — the higher, the better —
// and get their own bands. They are deliberately coarse: what the colour says
// is "mostly clean / mixed / mostly fossil", the exact figure is on the tile.
//
// NOTE. The colour tints the figure itself, which is why the tiles carry
// their own `value` rather than a `device_feature` (see the file header): the
// core draws a device-bound value in the default ink whatever the content
// says. The icon is coloured too, but only in the classic theme — the glass
// theme paints every tile icon in its accent colour.
// -----------------------------------------------------------------------------

/** Bands of a "clean share" percentage, from the cleanest down. */
const CLEAN_SHARE_BANDS = [
  { min: 70, color: WIDGET_COLORS.SUCCESS },
  { min: 40, color: WIDGET_COLORS.WARNING },
  { min: 0, color: WIDGET_COLORS.DANGER },
];

/** Semantic colour of a carbon-free / renewable share, in percent. */
function cleanShareColor(percentage) {
  if (!Number.isFinite(percentage)) {
    return WIDGET_COLORS.NEUTRAL;
  }
  return CLEAN_SHARE_BANDS.find((band) => percentage >= band.min).color;
}

// Tile labels, in one place: the same three names are used by the live and the
// static versions of the card.
const carbonIntensityLabel = () => ({ en: 'Carbon intensity', fr: 'Intensité carbone' });
const carbonFreeLabel = () => ({ en: 'Carbon-free', fr: 'Décarbonée' });
const renewableLabel = () => ({ en: 'Renewable', fr: 'Renouvelable' });

/**
 * How long the core may keep this content before pulling it again. The card
 * moves at the pace of the refresh loop, so anything shorter would only cost
 * WebSocket round-trips; the core clamps it to 10-3600 s anyway.
 */
function contentTtl(config) {
  return Math.min(Math.max(config.poll_frequency, 10), 3600);
}

/**
 * Age of a reading, as a multi-language text the core localizes on its own —
 * which is why the `language` of the request is not needed here. Kept short:
 * a status value holds 40 characters.
 */
function formatAge(seconds) {
  return {
    en: ageText(seconds, 'just now', (n, unit) => `${n} ${unit} ago`),
    fr: ageText(seconds, "à l'instant", (n, unit) => `il y a ${n} ${unit}`),
  };
}

function ageText(seconds, now, phrase) {
  if (seconds < 60) {
    return now;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? phrase(minutes, 'min') : phrase(Math.round(minutes / 60), 'h');
}

/**
 * Has the user created the device the tiles and the chart bind to? A
 * `device_feature` pointing at a device that does not exist renders nothing,
 * so the card falls back to plain values instead.
 *
 * `gladys.devices` is resynchronized on every (re)connection; a device created
 * since then is picked up by one `getDevices()`, which the content TTL keeps
 * from turning into a request per dashboard.
 */
async function isDeviceCreated(gladys, deviceExternalId) {
  if (gladys.devices?.some((device) => device.external_id === deviceExternalId)) {
    return true;
  }
  try {
    const devices = await gladys.getDevices();
    return devices.some((device) => device.external_id === deviceExternalId);
  } catch (err) {
    logger.warn('Could not check whether the device exists, falling back to plain values', err);
    return false;
  }
}
