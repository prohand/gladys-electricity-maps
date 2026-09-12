# Electricity Maps

This integration reads the **carbon intensity of the electricity grid** from
[Electricity Maps](https://www.electricitymaps.com/) and exposes it in Gladys as
sensors you can chart, and use in scenes to run your appliances when the
electricity is cleanest.

## What you get

One device, named after the zone you follow (for example
`Electricity Maps (FR)`), with three sensors:

| Sensor                  | Unit       | Meaning                                                     | Free plan |
| ----------------------- | ---------- | ----------------------------------------------------------- | --------- |
| Carbon intensity        | gCO₂eq/kWh | Emissions of the electricity consumed in the zone right now | Yes       |
| Carbon-free electricity | %          | Share coming from renewables **and** nuclear                | Yes       |
| Renewable electricity   | %          | Share coming from renewables only                           | No        |

All three keep their history, so they show up as charts on your dashboard.

The free **Home Assistant** key opens a single API endpoint: the one serving
the carbon intensity and the fossil share (hence the carbon-free share, its
complement). The renewable share comes from another endpoint, reserved to the
paid plans: the integration tries it once, and if your plan refuses it the
sensor simply stays empty — the two others keep working.

## Get an API key

The free access is the one named **Home Assistant** — it is the plan for
personal home automation, and it works exactly the same for Gladys.

1. Create an account on the
   [Electricity Maps portal](https://portal.electricitymaps.com/).
2. Go to **Settings → Access** and pick the **Home Assistant** tab (the other
   tabs, _Trial_ and _Academic_, are different offers). Activate it: its free
   use terms are personal, non-commercial and non-revenue-generating use —
   which is what a home automation server does.
3. Go to **Settings → API keys** and create your key, then copy it.
4. Note the **zone** displayed next to your key: a free Home Assistant key
   covers that single zone, and Gladys has to be told which one it is — it
   names and identifies the device before the first API call. Zone
   identifiers look like `FR`, `DE`, `ES`, `GB` or `US-CAL-CISO`; the full
   list is served by <https://api.electricitymaps.com/v3/zones>.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Paste the **API key** created with the Home Assistant access.
3. Set the **zone** to follow — the same one as on your key (`FR` by default).
4. Optionally adjust the **refresh interval** (900 seconds by default).
5. Save, then click **Test the connection**: the current carbon intensity of
   your zone is displayed under the button.
6. The device appears in the **Discovery** tab, ready to be added.

### Refresh interval

The integration runs its own refresh timer at the interval you set. Electricity
Maps updates its data roughly **once an hour**, and free plans have a monthly
request quota, so there is nothing to gain from refreshing faster. The value is
capped between **300 s** (5 minutes) and **86 400 s** (1 day), and changing it
applies immediately — no restart needed, and the new interval triggers a
refresh straight away.

Gladys can drive the polling of a device itself, but only at a fixed set of
intervals capped at one minute: far too fast for a metered, hourly API. That is
why the devices are published without a `poll_frequency`.

### Changing zone

The zone is part of the device identity: switching to another zone creates a
**new** device. The old one stops being refreshed and can be deleted from
Gladys.

## Ideas of scenes

- Start the dishwasher or charge the car when the carbon intensity drops below
  a threshold you choose.
- Send yourself a notification when the carbon-free share goes above 90 %.
- Chart your own consumption next to the grid intensity to see the CO₂ cost of
  your habits.

## Troubleshooting

| Message                            | What to do                                                         |
| ---------------------------------- | ------------------------------------------------------------------ |
| `Invalid API token ... (HTTP 401)` | Token mis-copied, **or** a zone different from the one on your key |
| `Zone ... not allowed (HTTP 403)`  | Your plan does not cover this zone — use your home zone            |
| `Unknown zone (HTTP 404)`          | Check the identifier against the list of zones                     |
| `quota exceeded (HTTP 429)`        | Increase the refresh interval, or wait for the quota to reset      |
| `Electricity Maps unreachable`     | Network or DNS problem on the Gladys host                          |

The integration logs everything it does: check the integration logs from the
Gladys UI (or `docker logs` on the host) with `LOG_LEVEL=debug` for the full
detail.

Some zones do not publish data at every hour. When that happens the missing
value is simply skipped for that round, instead of being written as a bogus
`0`.

The free plan is limited to **one zone** and **50 requests per hour**: at the
default interval (900 s) the integration uses 4 of them per hour.
