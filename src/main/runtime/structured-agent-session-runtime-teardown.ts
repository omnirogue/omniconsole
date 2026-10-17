// Tearing a structured agent-session runtime down, and retrying one that failed.
//
// Split out of the runtime module, which is at its line budget. The seam is the
// ORDER of the shutdown steps and the retry set that outlives a failed stop —
// neither belongs to the module slot the RPC layer reads.

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'

export type InstalledRuntime = {
  host: StructuredAgentSessionHost
  adapter: StructuredAgentSessionAdapterRouter
  /** Resolves after every observed adapter exit has published, and every
   *  recovery callback it raised has settled. */
  waitForRecovery: () => Promise<void>
}

/**
 * Runtimes whose teardown did not finish. Upstream clears `installing` regardless
 * so nothing new attaches, but dropping the runtime as well would strand every
 * journal the host retained for a retry: `tearDownStructuredAgentSessionHost`
 * deliberately keeps a failed close indexed, and only a later stop through this
 * same runtime can reach those entries again.
 */
export const pendingRuntimeTeardown = new Set<InstalledRuntime>()

/**
 * Tear down every outstanding runtime once each, re-retaining the ones that
 * fail. Returns the failures rather than throwing so the caller owns how a
 * single failure versus several is reported.
 *
 * A SET, not a list: upstream clears `installing` the moment a stop begins, so
 * its module slot and its retry set can never name the same runtime. OmniConsole
 * keeps `installing` across a FAILED stop on purpose — that is what lets
 * `ensureStructuredAgentSessionHost` refuse a reopen with "shutdown needs to
 * finish" rather than hand out a half-torn-down host. The cost is that the retry
 * stop sees the same runtime from both places, and tearing it down twice would
 * drain the journal close-retry registry twice, reporting a close that is still
 * failing as a success.
 */
export async function tearDownOutstandingRuntimes(
  outstanding: Iterable<InstalledRuntime>
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const runtime of new Set(outstanding)) {
    try {
      await tearDownRuntime(runtime)
    } catch (error) {
      pendingRuntimeTeardown.add(runtime)
      failures.push(error)
    }
  }
  return failures
}

async function tearDownRuntime(installed: InstalledRuntime): Promise<void> {
  // Drain an in-flight recovery before stopping children; recovery may still
  // be writing lifecycle rows or acquiring a replacement child.
  await installed.waitForRecovery()
  try {
    await installed.adapter.closeAll()
    // OmniConsole: native sessions carry hub publications, so they are closed
    // out (and their rows saved) before the host lets go of its journals.
    //
    // This used to sit AFTER a flush, which was harmless while
    // `flushAllStreamedEvents` only drained sinks. Upstream #18652 folded the
    // journal closes and the close-retry drain into it, so a flush here would
    // empty `host.sessions` first and `closeNativeSessions` would find nothing
    // left to close out — no session-stopped callback, and no publication saved.
    await installed.host.closeNativeSessions()
  } finally {
    // closeAll can itself deliver a final exit callback; observe that callback
    // before flushing and releasing the host's journal resources. Exactly ONE
    // flush per teardown: it now drains the journal close-retry registry, and a
    // second drain would report a still-failing close as a success.
    await installed.waitForRecovery()
    await installed.host.flushAllStreamedEvents()
  }
}
