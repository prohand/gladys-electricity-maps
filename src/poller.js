// -----------------------------------------------------------------------------
// Internal refresh timer.
//
// Why the integration owns its timer instead of letting Gladys drive it:
// a device published with a `poll_frequency` is polled by Gladys, but the core
// only accepts a closed list of values, in MILLISECONDS, capped at one minute
// (1 s, 2 s, 10 s, 15 s, 30 s, 60 s). Electricity Maps refreshes about once an
// hour and the free plans have a monthly request quota, so a one-minute floor
// is unusable here: the devices are published WITHOUT `poll_frequency` and the
// interval chosen by the user is honoured by this module.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

/**
 * Build a restartable refresh loop around a single async callback.
 *
 * @param {() => Promise<void>} refresh work to run on each tick; its errors are
 *   logged and swallowed, so one failed read never kills the loop.
 */
export function createPoller(refresh) {
  let timer = null;
  let intervalSeconds = null;
  // A slow API answer must not let two refreshes overlap and burn the quota
  // twice: a tick landing while the previous one still runs is dropped.
  let inFlight = false;

  async function tick() {
    if (inFlight) {
      logger.warn('Previous refresh still running, skipping this tick');
      return;
    }
    inFlight = true;
    try {
      await refresh();
    } catch (err) {
      logger.error('Scheduled refresh failed', err);
    } finally {
      inFlight = false;
    }
  }

  return {
    /**
     * Make the loop run at `seconds`, and refresh right away when that value
     * actually changes (first start, or the user edited the interval): the
     * caller may invoke this on every reconnection, where re-reading the API
     * would only waste quota, and it is then a no-op.
     *
     * @returns {boolean} true when the loop was (re)started, so the caller
     *   knows a refresh is already on its way and does not add a second one.
     */
    sync(seconds) {
      if (timer !== null && seconds === intervalSeconds) {
        return false;
      }
      this.stop();
      intervalSeconds = seconds;
      timer = setInterval(tick, seconds * 1000);
      logger.info(`Refreshing every ${seconds} s`);
      tick();
      return true;
    },

    /**
     * Refresh now, without touching the schedule: used when something other
     * than the interval changed (a new token, a new zone) and waiting for the
     * next tick would leave the user in front of stale or empty values.
     */
    async refreshNow() {
      await tick();
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        intervalSeconds = null;
      }
    },

    /** Current interval in seconds, or null when the loop is stopped. */
    get intervalSeconds() {
      return intervalSeconds;
    },
  };
}
