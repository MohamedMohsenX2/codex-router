// A child that crashes is the easy case: it exits, `waitForExit` resolves, and
// the supervisor restarts it. A child that wedges is the case nothing covered.
// The process is alive, so no exit ever resolves and no restart is ever
// considered; the port meanwhile either refuses connections or accepts them and
// never answers. What the user sees is a Codex turn that dies with `stream
// closed before response.completed`, reconnects that fail with `error sending
// request`, and a control center reporting the router Offline while its own
// control call times out -- with the service, from its own point of view, still
// running normally. Nothing was broken enough to notice.
//
// Health is polled once at startup and never again. This closes that gap: each
// supervised child is probed for the rest of its life, and one that stops
// answering is stopped so the supervisor treats it exactly like a crash.
//
// Liveness here is deliberately the weakest possible question. *Any* HTTP
// response counts as alive, including 503 -- the router answers 503 when the
// gateway is unreachable, and restarting the router because a provider is down
// would convert one bad upstream into a restart loop. Only a probe that times
// out or is refused is evidence that the process stopped serving.
//
// Tripping the watchdog restarts nothing by itself. It stops the child, which
// makes `waitForExit` resolve, and the supervisor's existing path counts the
// failure, applies its backoff, and waits for health before declaring it back.
// A wedge is therefore bounded by the same restart budget as a crash, and a
// misfiring watchdog cannot respawn faster than a crash loop already can.

export const DEFAULT_PROBE_INTERVAL_MS = 15_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
// Four consecutive misses, so a child has to be unreachable for roughly a
// minute before it is replaced. One missed probe is a loaded machine; a minute
// of refusing connections is not something a caller can wait out.
export const DEFAULT_FAILURES_BEFORE_RESTART = 4;
// A wedged process cannot run its own signal handler -- a blocked event loop
// never reaches it -- and the router's SIGTERM handler waits for in-flight
// requests to finish, which is precisely what a wedge prevents. Escalate rather
// than leave the supervisor parked on an exit that will never come.
export const DEFAULT_STOP_GRACE_MS = 5_000;

function positiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < 0) return fallback;
  if (floored === 0 && !allowZero) return fallback;
  return floored;
}

// `CODEX_ROUTER_LIVENESS_FAILURES=0` turns the watchdog off and restores the
// exit-only behaviour, which is what a crash investigation wants: a wedged
// process should stay wedged and inspectable rather than being replaced.
export function livenessLimits(env = process.env) {
  return {
    intervalMs: positiveInteger(env.CODEX_ROUTER_LIVENESS_INTERVAL_MS, DEFAULT_PROBE_INTERVAL_MS),
    timeoutMs: positiveInteger(env.CODEX_ROUTER_LIVENESS_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
    failuresBeforeRestart: positiveInteger(
      env.CODEX_ROUTER_LIVENESS_FAILURES,
      DEFAULT_FAILURES_BEFORE_RESTART,
      { allowZero: true },
    ),
  };
}

export function isRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

async function drain(response) {
  if (typeof response?.arrayBuffer === "function") {
    await response.arrayBuffer().catch(() => {});
  } else if (typeof response?.body?.cancel === "function") {
    await response.body.cancel().catch(() => {});
  }
}

/**
 * One liveness probe. True when the process answered at all.
 *
 * The status is not consulted on purpose: see the header. A thrown error --
 * refused, reset, or the timeout this imposes -- is the only "no".
 */
export async function probeLiveness({
  url,
  headers = {},
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await drain(response);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM first so a child that can still run its handler shuts down cleanly,
// SIGKILL after the grace period for one that cannot. The timer is unref'd:
// nothing here should hold the service open.
export function stopUnresponsive(child, { graceMs = DEFAULT_STOP_GRACE_MS, log } = {}) {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  const escalate = setTimeout(() => {
    if (!isRunning(child)) return;
    log?.("it did not stop on SIGTERM; sending SIGKILL.");
    child.kill("SIGKILL");
  }, graceMs);
  escalate.unref?.();
}

/**
 * Probe `child` for as long as it runs, and stop it when it stops answering.
 *
 * Returns a handle with `cancel()` -- which the supervisor calls the moment the
 * child exits for any other reason -- and `done`, a promise resolving to
 * `{ tripped }` so a caller (or a test) can tell a watchdog kill from an
 * ordinary exit.
 */
export function watchLiveness({
  label = "the child",
  child,
  url,
  headers = {},
  probe,
  intervalMs = DEFAULT_PROBE_INTERVAL_MS,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  failuresBeforeRestart = DEFAULT_FAILURES_BEFORE_RESTART,
  stop = stopUnresponsive,
  isShuttingDown = () => false,
  log = (message) => console.error(message),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl = fetch,
} = {}) {
  let cancelled = false;
  const probeOnce = probe || (() => probeLiveness({ url, headers, timeoutMs, fetchImpl }));
  const stopped = () => cancelled || isShuttingDown() || !isRunning(child);

  const done = (async () => {
    if (failuresBeforeRestart <= 0) return { tripped: false, disabled: true };
    let consecutive = 0;

    while (!stopped()) {
      await sleep(intervalMs);
      if (stopped()) break;

      if (await probeOnce()) {
        if (consecutive > 0) {
          log(`${label} is answering its liveness probe again after ${consecutive} miss(es).`);
        }
        consecutive = 0;
        continue;
      }
      if (stopped()) break;

      consecutive += 1;
      log(
        `${label} did not answer its liveness probe ` +
          `(${consecutive} of ${failuresBeforeRestart} before it is restarted).`,
      );
      if (consecutive < failuresBeforeRestart) continue;

      log(
        `${label} has not answered for ${consecutive} probe(s); it is alive but not ` +
          `serving, so it is being stopped and restarted. Clients see refused ` +
          `connections until it answers again.`,
      );
      stop(child, { log: (message) => log(`${label}: ${message}`) });
      return { tripped: true, misses: consecutive };
    }
    return { tripped: false };
  })();

  return {
    cancel() {
      cancelled = true;
    },
    done,
  };
}
