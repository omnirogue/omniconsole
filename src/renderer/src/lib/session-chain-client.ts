import type { SessionChain } from '../../../shared/session-chain-types'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

const RPC_TIMEOUT_MS = 15_000

/** Chains live in the main state file; the renderer only reads and writes them here. */
export async function listSessionChainsFromHost(
  target: RuntimeClientTarget
): Promise<SessionChain[]> {
  const result = await callRuntimeRpc<{ chains: SessionChain[] }>(
    target,
    'sessionChain.list',
    undefined,
    { timeoutMs: RPC_TIMEOUT_MS }
  )
  return result.chains
}

export async function upsertSessionChainOnHost(
  target: RuntimeClientTarget,
  chain: SessionChain
): Promise<SessionChain> {
  const result = await callRuntimeRpc<{ chain: SessionChain }>(
    target,
    'sessionChain.upsert',
    { chain },
    { timeoutMs: RPC_TIMEOUT_MS }
  )
  return result.chain
}

export async function removeSessionChainOnHost(
  target: RuntimeClientTarget,
  id: string
): Promise<void> {
  await callRuntimeRpc(target, 'sessionChain.remove', { id }, { timeoutMs: RPC_TIMEOUT_MS })
}

export async function listSessionChainOutputFilesFromHost(
  target: RuntimeClientTarget,
  args: { workspacePath: string; chainId: string; stepId: string }
): Promise<{ outputDir: string; files: string[]; truncated: boolean }> {
  return callRuntimeRpc(target, 'sessionChain.outputFiles', args, { timeoutMs: RPC_TIMEOUT_MS })
}

/**
 * The previous session's last output, read with an explicit line limit. A plain
 * terminal session is read through terminal.read (the worker equivalent is
 * orchestration.workerRead, which the Phase 2 runner uses).
 */
export async function readTerminalTailFromHost(
  target: RuntimeClientTarget,
  handle: string,
  limit: number,
  signal?: AbortSignal
): Promise<string> {
  const result = await callRuntimeRpc<{ terminal: RuntimeTerminalRead }>(
    target,
    'terminal.read',
    { terminal: handle, limit },
    { timeoutMs: RPC_TIMEOUT_MS, signal }
  )
  return result.terminal.tail.join('\n').trim()
}
