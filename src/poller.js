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
import { UNREACHABLE_STATUS } from './electricityMaps.js';

// Short retries after a read that never reached Electricity Maps. The usual
// case is the container starting before the network is up (EAI_AGAIN): without
// them the sensors stay empty for a whole interval, up to a day. Such a failure
// costs no quota, and two retries at most per tick keep a real outage from
// turning into a busy loop. A retry that would land after the next scheduled
// tick is not scheduled: that tick is the retry.
export const NETWORK_RETRY_DELAYS_SECONDS = [60, 300];

/**
 * How long to wait before retrying a failed read, or null for "wait for the
 * next tick". Only two failures are worth an early retry: the API was not
 * reached at all, and a 429 that said when to come back (`Retry-After`).
 * Anything else (a refused token, an unknown zone, a 5xx) would fail the same
 * way a minute later, and a 429 without a date gives nothing to go on.
 *
 * @param {Error & { status?: number, retryAfterSeconds?: number|null }} err
 * @param {number} attempt retries already made for this tick (0 for the first)
 * @returns {number|null} seconds
 */
export function retryDelaySeconds(err, attempt) {
  if (attempt >= NETWORK_RETRY_DELAYS_SECONDS.length) {
    return null;
  }
  if (err?.status === UNREACHABLE_STATUS) {
    return NETWORK_RETRY_DELAYS_SECONDS[attempt];
  }
  if (err?.status === 429 && Number.isFinite(err.retryAfterSeconds)) {
    return err.retryAfterSeconds;
  }
  return null;
}

/**
 * Build a restartable refresh loop around a single async callback.
 *
 * @param {() => Promise<void>} refresh work to run on each tick. Its errors are
 *   logged and swallowed for the scheduled ticks, so one failed read never
 *   kills the loop, but handed to the caller of `refreshNow()`, who asked for
 *   fresh values and must not be served old ones as if they were.
 * @param {object} [options]
 * @param {typeof retryDelaySeconds} [options.retryDelay] retry policy
 */
export function createPoller(refresh, { retryDelay = retryDelaySeconds } = {}) {
  let timer = null;
  let intervalSeconds = null;
  // When the interval fires next, so a retry never lands after it.
  let nextTickAt = null;
  // A slow API answer must not let two refreshes overlap and burn the quota
  // twice: a tick landing while the previous one still runs is dropped.
  let inFlight = null;
  // A refresh asked while another one runs (a new token, a scene, the widget
  // button): one follow-up read, shared by every caller that asked meanwhile.
  let followUp = null;
  // Early retry after a failed read (see NETWORK_RETRY_DELAYS_SECONDS).
  let retryTimer = null;
  let retryAttempt = 0;
  // A 429 said when to come back: no scheduled read before that.
  let notBefore = 0;

  function cancelRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(err) {
    if (err?.status === 429 && Number.isFinite(err.retryAfterSeconds)) {
      notBefore = Date.now() + err.retryAfterSeconds * 1000;
    }
    const delay = timer === null ? null : retryDelay(err, retryAttempt);
    if (delay === null) {
      return;
    }
    if (Date.now() + delay * 1000 >= nextTickAt) {
      return;
    }
    logger.info(`Retrying the refresh in ${delay} s`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryAttempt += 1;
      tick('retry');
    }, delay * 1000);
  }

  /**
   * One read. Rejects with the refresh error, after scheduling a retry when
   * the failure deserves one.
   * @param {'schedule'|'retry'|'request'} source what asked for it
   */
  async function read(source) {
    if (source !== 'retry') {
      // A new tick or an explicit request supersedes a pending retry, and
      // starts its own retry budget.
      cancelRetry();
      retryAttempt = 0;
    }
    let settle;
    inFlight = new Promise((resolve) => {
      settle = resolve;
    });
    try {
      await refresh();
      retryAttempt = 0;
    } catch (err) {
      scheduleRetry(err);
      throw err;
    } finally {
      inFlight = null;
      settle();
    }
  }

  /** A read nobody waits for: its failure is logged, never thrown. */
  function tick(source) {
    if (inFlight) {
      logger.warn('Previous refresh still running, skipping this tick');
      return;
    }
    if (Date.now() < notBefore) {
      logger.warn('Electricity Maps asked to wait (HTTP 429): skipping this refresh');
      return;
    }
    read(source).catch((err) => {
      logger.warn(`Scheduled refresh failed: ${err?.message ?? err}`);
    });
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
      nextTickAt = Date.now() + seconds * 1000;
      timer = setInterval(() => {
        nextTickAt = Date.now() + seconds * 1000;
        tick('schedule');
      }, seconds * 1000);
      logger.info(`Refreshing every ${seconds} s`);
      tick('schedule');
      return true;
    },

    /**
     * Refresh now, without touching the schedule: used when something other
     * than the interval changed (a new token, a new zone) and waiting for the
     * next tick would leave the user in front of stale or empty values, and
     * by the scene action and the widget button asking for fresh values.
     *
     * Unlike a scheduled tick, a failure REJECTS: the caller asked for a fresh
     * read, and answering with the previous one as if it had just been taken
     * is exactly what it must not get.
     */
    async refreshNow() {
      if (Date.now() < notBefore) {
        throw new Error(
          `Electricity Maps asked to wait (HTTP 429) until ${new Date(notBefore).toISOString()}`,
        );
      }
      if (!inFlight) {
        await read('request');
        return;
      }
      // The running read may predate what the caller just changed (a new
      // token or zone) or wants (fresh values): skipping it, as a scheduled
      // tick does, left stale values until the next tick. Read once more
      // right after it instead.
      followUp ??= (async () => {
        try {
          while (inFlight) {
            await inFlight;
          }
        } finally {
          followUp = null;
        }
        await read('request');
      })();
      await followUp;
    },

    stop() {
      cancelRetry();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        intervalSeconds = null;
        nextTickAt = null;
      }
    },

    /** Current interval in seconds, or null when the loop is stopped. */
    get intervalSeconds() {
      return intervalSeconds;
    },
  };
}
