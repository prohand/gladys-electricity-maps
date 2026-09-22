# Electricity Maps — Gladys Assistant integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
publishes the **carbon intensity of your electricity grid** as Gladys sensors,
using the [Electricity Maps](https://www.electricitymaps.com/) API.

Built from the
[official JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
and the SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## What it publishes

One device per zone (`Electricity Maps (FR)`, `Electricity Maps (DE)`…) with
two or three read-only, history-keeping sensors:

| Feature                 | Type                     | Unit       | API source                       | Free plan |
| ----------------------- | ------------------------ | ---------- | -------------------------------- | --------- |
| Carbon intensity        | `carbon-intensity`       | gCO₂eq/kWh | `GET /v3/home-assistant`         | Yes       |
| Carbon-free electricity | `carbon-free-percentage` | %          | `GET /v3/home-assistant`         | Yes       |
| Renewable electricity   | `renewable-percentage`   | %          | `GET /v3/power-breakdown/latest` | No        |

The renewable sensor is only published when the plan actually serves the power
breakdown: `probeCapabilities` asks that endpoint once per token+zone, before
the discovery payload is built, and a 401/403 takes the feature out of it. A
sensor no endpoint can fill would otherwise sit on the dashboard reading "no
recent value" forever. The probe payload is handed over to the poll that
follows (`takeProbedBreakdown`), so the check costs no extra request, and a
refusal that only a poll discovers (the probe hit a network error) changes
`capabilitiesSignature`, which makes `refreshAllDevices` re-publish the devices
without the feature.

They are published in the core's **`grid-carbon-sensor`** category (see
`src/features.js`): that is what gives them their Gladys name, icon, unit and
chart grouping. A Gladys that does not know the category yet rejects the whole
discovery payload with `400 unknown category`, so the integration republishes
the same sensors as generic `unknown` features — they show up as "Unknown" in
the UI, but they show up, and the values are the same.

Two consequences worth knowing:

- the category, the types and the unit (`gram-co2eq-per-kilowatt-hour`) are not
  exported by the published SDK yet, so `src/features.js` mirrors the core
  strings and prefers the SDK constants as soon as a release carries them;
- the core upserts the **params** of an already-created device on re-publish,
  never its feature categories: a device created while the fallback was active
  keeps its "Unknown" features. Delete it and re-add it from the **Discovery**
  screen to get the real ones.

`/v3/home-assistant` is the only endpoint the free "Home Assistant" access
serves; it returns the carbon intensity and the fossil share, whose complement
is the carbon-free share. The full endpoints (`/v3/carbon-intensity/latest`,
`/v3/power-breakdown/latest`) belong to the paid plans and answer **401** to a
free key — which is why the renewable share is probed once per token+zone and
then dropped, feature included, when the plan refuses it, instead of burning a
request on every poll. The two reads are independent: one failing never loses
the other.

## Dashboard widget, scene trigger and scene action

Gladys 5.1 lets an external integration extend the dashboard and the scene
editor from its manifest. This integration declares one of each, all built on
the **last reading the refresh loop already did** (`src/gridSnapshot.js`): none
of them ever costs an extra Electricity Maps request unless the user explicitly
asks for one.

### Widget — `grid_carbon`

One card, built around the device once the user created it:

- a **status** block with the zone, the carbon **level** and the hour the
  value belongs to (the API serves hourly values, so the hour of the value,
  not the time of the poll) — the three things no device feature holds;
- **live tiles** bound to the features (`device_feature`), so they follow the
  published states instead of the content TTL;
- a **chart** bound to the carbon intensity feature over the last 24 h, so the
  core draws the history it already keeps rather than us re-sending points;
- a **Refresh** button (a live read, relayed through `onWidgetAction`) and a
  link to the Electricity Maps map of the zone.

The card is never empty: with no token it says what to configure, with no
reading yet it says so, and while the device does not exist it shows the plain
values and points at the Discovery screen. Every one of those states is checked
against the SDK's own `validateWidgetContent` in `test/widgets.test.js` — an
empty report means the core renders the content exactly as sent.

### Scene trigger — `carbon_level_changed`

Fires when the carbon intensity of the zone moves from one **level** to
another:

| Level       | Carbon intensity     |
| ----------- | -------------------- |
| `very_low`  | < 100 gCO₂eq/kWh     |
| `low`       | 100 – 200 gCO₂eq/kWh |
| `moderate`  | 200 – 400 gCO₂eq/kWh |
| `high`      | 400 – 600 gCO₂eq/kWh |
| `very_high` | ≥ 600 gCO₂eq/kWh     |

The scene author filters on the new level, on the direction (cleaner /
dirtier), or on neither — an empty filter is a wildcard. The event exposes
`zone`, `level`, `previous_level`, `direction`, `carbon_intensity`,
`carbon_free_percentage` and `renewable_percentage` as
`{{triggerEvent.data.<key>}}`.

Two rules make it usable in a scene:

- **one event per transition**, never one per refresh — the first reading of a
  zone fires nothing (the grid did not change, we just started looking);
- **hysteresis of 10 gCO₂eq/kWh** (`src/carbonLevel.js`): a value sitting on a
  boundary has to move past it by the margin before the level follows, so a
  grid hovering at 98–104 never restarts the scene every 15 minutes.

Thresholds themselves are deliberately **not** a trigger: the carbon intensity
is a state, published as a sensor, and Gladys already compares a device feature
to a number. What the core cannot express is the transition, which is exactly
what this trigger adds.

### Scene action — `get_grid_data`

Hands the last reading to the following actions of the scene, as the outputs
`zone`, `level`, `carbon_intensity`, `carbon_free_percentage`,
`renewable_percentage` and `age_seconds`.

A **Read Electricity Maps first** toggle (off by default) forces a live read
before answering. It is an explicit choice, not a default, because a free key
has a monthly request quota and the data only moves about once an hour. The
action fails rather than returning invented values when nothing was ever read:
the rest of the scene must not branch on a number nobody measured.

## Polling

The integration owns the timer (`src/poller.js`), running at the user setting
_Refresh interval_ and calling the blueprints' `onPoll`.

Gladys can drive the polling itself, from a **`poll_frequency`** declared on
the device — but the core validates that field against a closed list of values,
in **milliseconds**, capped at **one minute** (`1 s, 2 s, 10 s, 15 s, 30 s,
60 s`); anything else is rejected with `400 invalid poll frequency`. A
once-an-hour, quota-metered API has no business being read every minute, so the
devices are published **without** `poll_frequency`.

- default: **900 s**, bounds **300 s – 86 400 s** (manifest `min`/`max`, and
  clamped again in `src/config.js` so an out-of-range value can never hammer
  the API);
- changing it restarts the loop and refreshes right away, without a restart of
  the container; changing the token or the zone also refreshes right away, even
  though the interval itself did not move;
- creating the device from the discovery list fills its sensors immediately
  (`onDeviceCreated`), replaying the last batch read when it is younger than one
  interval, so the user never faces empty features for a whole `poll_frequency`;
- a tick landing while the previous refresh still runs is dropped, and a failed
  refresh is logged without stopping the loop;
- nothing is requested while Gladys is unreachable or while the token/zone are
  missing: the states would be lost anyway.

Electricity Maps refreshes roughly once an hour and free plans carry a monthly
request quota: polling faster buys nothing.

## Configuration

| Key              | Type     | Default | Description                                     |
| ---------------- | -------- | ------- | ----------------------------------------------- |
| `api_token`      | `secret` | —       | Personal token from the Electricity Maps portal |
| `zone`           | `string` | `FR`    | Zone to follow (`FR`, `DE`, `US-CAL-CISO`…)     |
| `poll_frequency` | `number` | `900`   | Refresh interval, in seconds                    |

The free API key is the one issued under the **Home Assistant** access of the
[portal](https://portal.electricitymaps.com/) (**Settings → Access → Home
Assistant**, then **Settings → API keys**) — the plan for personal,
non-commercial home automation, which is what Gladys is. _Trial_ and
_Academic_ are separate offers.

The token is a `secret` field: it is stored by Gladys and never sent back to
the frontend. A **Test the connection** button in the Configuration screen
performs a live request and shows the current carbon intensity of the zone.

The zone is part of the device identity: switching zone creates a new device
rather than rewriting the history of the previous one.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no API logic)
├─ src/
│  ├─ devices/
│  │  ├─ index.js                    #   device registry
│  │  └─ gridCarbon.js               #   the grid device: features + onPoll
│  ├─ widgets.js                     # dashboard widget: content + button handler
│  ├─ scenes.js                      # scene trigger event + scene action handlers
│  ├─ carbonLevel.js                 # carbon intensity bands and their hysteresis
│  ├─ gridSnapshot.js                # last reading, shared by the widget and the scenes
│  ├─ features.js                    # Gladys feature category/types/unit (+ fallback)
│  ├─ electricityMaps.js             # Electricity Maps API driver (the only fetch)
│  ├─ poller.js                      # internal refresh loop (Gladys caps polling at 1 min)
│  └─ config.js                      # config defaults, normalization, clamping
├─ docs/en.md, docs/fr.md            # user documentation, re-hosted by Gladys
├─ assets/cover.html                 # source of the catalog cover (see below)
├─ cover.jpg                         # catalog cover, 800×534 px
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="electricity-maps" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # Unit tests (built-in `node --test` runner)
```

The same three gates run on every push and pull request
(`.github/workflows/ci.yml`). Tests use mocked `fetch`: no API token and no
network access are needed to run them.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact checks of the store indexer (manifest schema, Docker image
availability, cover image, code rules) and reports every problem at once.

## Release

**Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
workflow bumps the version in `package.json` and in the manifest (`version` +
`docker_image` tag), pushes the `vX.Y.Z` tag and builds the
`linux/amd64` + `linux/arm64` image to `ghcr.io` (`:X.Y.Z` and `:latest`).

For the integration to appear in the Gladys catalog, the repository must be
public and carry the GitHub topic `gladys-assistant-integration`.

## Notes

- Requires **Node.js ≥ 20** (built-in global `fetch`, no HTTP dependency).
- Requires **Gladys ≥ 5.1.0**: the `widgets`, `scene_triggers` and
  `scene_actions` manifest fields appeared there, and an older core rejects the
  whole manifest on any field it does not know (the same rule as `categories`).
- No standard Gladys unit exists for gCO₂eq/kWh: the carbon intensity feature
  uses the generic `unknown` category and carries its unit in its name. The two
  percentages use the standard `percent` unit.
- `transports: ["cloud"]` — Electricity Maps is a public HTTP API, there is no
  LAN path, so Gladys shows no "Prefer the local connection" toggle.
- API errors are translated into actionable messages (bad token, zone not
  allowed, unknown zone, quota exceeded) and the token never appears in a log
  line or an error message.
- The catalog cover is rendered from [`assets/cover.html`](assets/cover.html),
  so it can be edited like a web page instead of in an image editor. Re-render
  it with a headless Chromium at 800×534 and save it as `cover.jpg` (the store
  accepts PNG or JPEG, 800×534 px, 150 KB max — a PNG of this gradient weighs
  more than that, hence the JPEG).

## License

Apache-2.0
