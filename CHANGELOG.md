# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [2.2.0] - 2026-10-07

- Maintenance release, no functional change.

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).
- Manifest re-formatted with Prettier, so the CI format check passes again.

### Fixed

- A refresh asked while another one is running (new token or zone saved, widget Refresh button, scene action) is no longer dropped: it reads once more right after, so the sensors no longer keep the old zone's values until the next tick.
- `src/devices/gridCarbon.js` no longer contains a raw NUL character, which made git show it as a binary file.
- The Release workflow re-runs Prettier on the manifest after `jq`, so a release no longer leaves `main` with a failing CI format check.

## [2.0.5] - 2026-09-22

### Changed

- Show the hour of the value on the widget, not the age of the poll

## [2.0.4] - 2026-09-22

### Changed

- Log the hour of the carbon intensity, explain the gap with the site

## [2.0.3] - 2026-09-22

### Changed

- Colour the figures of the widget tiles, like the device badges
- Say what the coloured tiles cost

## [2.0.1] - 2026-09-22

### Changed

- Colour the widget tiles after what they read

## [2.0.0] - 2026-09-22

### Added

- Add the Gladys 5.1 dashboard widget, scene trigger and scene action

## [1.0.1] - 2026-09-21

First public release.

### Added

- Electricity Maps integration for Gladys Assistant
- Real catalog cover rendered from HTML
- Publish the sensors in the grid-carbon-sensor category
- Fill the sensors as soon as the device is created
- Stop publishing the renewable sensor when the plan refuses it

### Changed

- Say the free API key is the "Home Assistant" access
- Tell the user to copy the zone shown on their API key

### Fixed

- Drive the refresh from our own timer, not poll_frequency
- Read the endpoint a free Home Assistant key may call
- Stop publishing the device before the API token is set

[Unreleased]: https://github.com/prohand/gladys-electricity-maps/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/prohand/gladys-electricity-maps/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-electricity-maps/compare/v2.0.5...v2.1.0
[2.0.5]: https://github.com/prohand/gladys-electricity-maps/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/prohand/gladys-electricity-maps/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/prohand/gladys-electricity-maps/compare/v2.0.1...v2.0.3
[2.0.1]: https://github.com/prohand/gladys-electricity-maps/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-electricity-maps/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/prohand/gladys-electricity-maps/releases/tag/v1.0.1
