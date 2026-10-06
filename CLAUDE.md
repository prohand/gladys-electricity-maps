# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 20+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) that publishes the carbon intensity of the
electricity consumed in one [Electricity Maps](https://www.electricitymaps.com) zone: carbon
intensity (gCO2eq/kWh), carbon-free share and, when the plan allows it, renewable share. One
device per zone. Needs an Electricity Maps API token (the free "Home Assistant" access works).
Gladys 5.1+ adds a dashboard widget, a scene trigger and a scene action.

## Commands

```bash
npm install
npm test                                   # node --test (built-in runner)
node --test test/poller.test.js            # one file
node --test --test-name-pattern "probe"    # one test by name
npm run lint                               # eslint .
npm run format:check                       # prettier --check . (CI gate)
npm run format                             # prettier --write .
```

CI runs `format:check`, `lint`, `test`. Releases: **Actions → Release** only (bumps
`package.json`, manifest `version` + `docker_image`, tags, builds). The release rewrites the
manifest with `jq`: run `npm run format` afterwards or CI fails.

## Architecture

```
index.js                  SDK wiring only, handlers registered before connect()
src/config.js             defaults, refresh interval clamp (seconds), isConfigured()
src/poller.js             the integration's own refresh loop (no overlapping ticks)
src/electricityMaps.js    API client (`auth-token` header), endpoints every plan serves
src/devices/index.js      blueprint registry, publishDevices(), capabilitiesSignature()
src/devices/gridCarbon.js the "electricity grid" device: probe, poll, replay on creation
src/features.js           feature categories (grid-carbon-sensor) and units
src/carbonLevel.js        carbon intensity -> level (used by trigger, widget, badges)
src/gridSnapshot.js       last reading, shared by widget, scene action and trigger
src/scenes.js             scene action(s)
src/widgets.js            dashboard widget (tiles coloured after what they read)
```

### Invariants worth knowing

- **No `poll_frequency` on devices.** Gladys only accepts values up to one minute, far too fast
  for an hourly, monthly-metered API. `createPoller` runs the loop at the configured interval
  (default 900 s); `sync()` is a no-op when the interval did not change, so a reconnection never
  costs a request. `onPoll` stays registered but is not the driver.
- **Nothing is published before a token and a zone exist** (`publishDevices` checks
  `isConfigured`): a device offered earlier would keep empty sensors forever.
- **The power breakdown is probed once per token+zone** (`probeCapabilities`): a plan that
  refuses it (401/403) gets a device without the renewable sensor and stops asking. When a poll
  changes what is advertised, `refreshAllDevices` re-publishes the devices.
- **States sent before the device exists are lost** in Gladys, so the last batch is kept and
  replayed by `onDeviceCreated`.
- **Every API read goes through one tick** (`poller.refreshNow()`): widget refresh button and
  scene action reuse it, so two reads never overlap and burn the quota twice.
- **The token is a secret**: never log it nor put it in a device param or widget content.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys).
- **Scene trigger `carbon_level_changed` fires on a transition** of the carbon level, never on
  the first reading. Widget, trigger and action keys are stored by users: never rename them.
- **A refresh asked during a running one is not dropped** (`poller.refreshNow()`): it reads once
  more right after, shared by every caller that asked meanwhile. Scheduled ticks still skip.

### Manifest

`test/manifest.test.js` keeps `gladys-assistant-integration.json` in sync with `DEFAULT_CONFIG`,
the interval bounds, the action handlers and the widget/scene keys (`gladys_version >=5.1.0`).

## Testing

No network: `globalThis.fetch` is stubbed per file; `test/helpers/fakeGladys.js` stands in for
the SDK. Module-level state in `gridCarbon.js` (plan probe, last states) must be reset between
tests through the helpers it exports.

## Conventions

Prettier formats, ESLint catches mistakes. Comments explain **why**, in English, with a header
block per file. User-facing messages are bilingual `{ en, fr }`; user docs in `docs/en.md` and
`docs/fr.md`, kept in sync. The container rootfs is read-only: write nothing.
