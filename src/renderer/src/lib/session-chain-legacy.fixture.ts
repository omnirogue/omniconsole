import type { Worktree } from '../../../shared/worktree/types'
import type { SidebarSession } from './sidebar-sessions'
import type { SessionChain, SessionChainStep } from '../../../shared/session-chain-types'
import { buildCompiledSessionChain } from './session-chain-build'
import {
  setSessionChainEntry,
  publishSessionChains,
  persistSessionChain
} from './session-chain-registry'
import { runSessionChainNow } from './session-chain-runner'
import { randomChainId, type SessionChainStepDraft } from './session-chain-support'
import { toast } from 'sonner'
import { queuedToast } from './session-chain-notices'

// Test-only restoration of historical plans; production admission is host-owned.
/** Put a built chain in place, persist it and start its run. One chain per source row. */
function restoreChain(chain: SessionChain): SessionChain {
  setSessionChainEntry(chain)
  publishSessionChains()
  void persistSessionChain(chain)
  toast.success(queuedToast(chain))
  runSessionChainNow(chain.id)
  return chain
}

/** Queue compiled steps (agents, people, fan-outs) after a live session; the chain id is minted here. */
export function restoreCompiledLegacyChain(args: {
  session: SidebarSession
  chainId: string
  end?: SessionChain['end']
  placement?: SessionChain['placement']
  destination?: Worktree
  steps: readonly SessionChainStep[]
  auto: boolean
}): SessionChain | null {
  const chain = buildCompiledSessionChain(args)
  return chain ? restoreChain(chain) : null
}

/** Queue an ordered list of successors after a live session. Launches happen as each session finishes. */
export function restoreLegacyChain(args: {
  session: SidebarSession
  steps: readonly SessionChainStepDraft[]
  auto: boolean
}): SessionChain | null {
  return restoreCompiledLegacyChain({
    session: args.session,
    chainId: randomChainId('chn'),
    auto: args.auto,
    steps: args.steps.map((draft, index) => ({
      id: `step_${index + 1}_${randomChainId('s').slice(2)}`,
      agent: draft.agent,
      prompt: draft.prompt,
      ...(draft.presetId ? { presetId: draft.presetId } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      ...(draft.accountChoiceId ? { accountChoiceId: draft.accountChoiceId } : {}),
      status: 'queued'
    }))
  })
}
