/**
 * The requesting side's end-to-end fixture: a Mac's paired connection to a real test host (A's
 * admission, journal and runtime RPC entry point, with a fake executor), and the ways a host can
 * fail to answer. Package E's tests use it; B2 and E2 can reuse it for the relay and relocation.
 */

import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { SESSION_HOST_CLIENT_CAPABILITIES } from '../../shared/session-host-capabilities'
import type { SessionHostClientTransport } from '../../shared/session-host-client'
import { legacyRuntimeStatus } from '../../shared/session-host-wire-fixtures'
import type { RpcContext } from '../runtime/rpc/core'
import { runtimeSessionHostTransport } from '../session-host/session-host-client-transports'
import {
  handleRuntimeSessionHostCall,
  runtimeSessionHostStatus,
  setRuntimeSessionHostProcessForTests
} from '../session-host/session-host-runtime'
import {
  adoptTestConversation,
  FakeSessionHostExecutor,
  testHostProcess
} from '../session-host/session-host-test-fixture'

export const REMOTE_TEST_RUNTIME_ID = 'runtime-1'
/** The pane `adoptTestConversation` binds its conversation to. */
export const REMOTE_TEST_PANE = 'tab-1:claude-session-1'

/** A paired runtime on `root` running one adopted conversation; install it as this process's. */
export async function remoteTestRuntime(root: string) {
  const executor = new FakeSessionHostExecutor()
  const process = testHostProcess({ root, incarnation: REMOTE_TEST_RUNTIME_ID, executor })
  setRuntimeSessionHostProcessForTests(process)
  const { conversationId } = await adoptTestConversation(await process.service())
  return { executor, conversationId }
}

/**
 * A Mac's paired connection to that runtime through the real RPC entry point; `legacy` answers
 * `status.get` as a runtime released before Phase 4. `calls` records every method sent.
 */
export function pairedMacTransport(
  device: string,
  options: { calls?: string[]; legacy?: boolean } = {}
): SessionHostClientTransport {
  const runtime = { getRuntimeId: () => REMOTE_TEST_RUNTIME_ID } as RpcContext['runtime']
  return runtimeSessionHostTransport(async (method, params) => {
    options.calls?.push(method)
    const meta = { runtimeId: REMOTE_TEST_RUNTIME_ID }
    if (method === 'status.get') {
      const status = runtimeSessionHostStatus(REMOTE_TEST_RUNTIME_ID)
      const result = options.legacy
        ? { ...legacyRuntimeStatus(), runtimeId: REMOTE_TEST_RUNTIME_ID }
        : {
            runtimeId: REMOTE_TEST_RUNTIME_ID,
            capabilities: status?.capabilities ?? [],
            ...(status ? { sessionHost: status.sessionHost } : {})
          }
      return { id: '1', ok: true, _meta: meta, result } as RuntimeRpcResponse<unknown>
    }
    const result = await handleRuntimeSessionHostCall(method as never, params, {
      runtime,
      pairedDeviceId: device,
      clientCapabilities: [...SESSION_HOST_CLIENT_CAPABILITIES]
    })
    return { id: '1', ok: true, _meta: meta, result } as RuntimeRpcResponse<unknown>
  })
}

/** A host that cannot be asked at all: every probe and call fails (a partition). */
export const UNREACHABLE_HOST_TRANSPORT: SessionHostClientTransport = {
  probe: () => Promise.reject(new Error('timeout')),
  call: () => Promise.reject(new Error('socket closed')),
  connection: () => null
}

export function resetRemoteTestRuntime(): void {
  setRuntimeSessionHostProcessForTests(null)
}
