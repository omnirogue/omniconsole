import { getWorktreeExecutionHostId } from '../../../shared/execution-host'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { launchAgentSessionContinuation } from '@/lib/launch-agent-session-continuation'
import { createTerminalWaitDependencies } from '@/lib/next-session-launch'
import { resolveSessionActorLaunch } from '@/lib/session-actor'
import { listSessionChainOutputFilesFromHost } from '@/lib/session-chain-client'
import { buildSessionChainStepPrompt } from '@/lib/session-chain-prompt'
import { readSessionWorkOutput } from '@/lib/session-work-output'
import {
  sourcePaneKeysForStep,
  sleepUnlessAborted,
  waitForPaneAgentWorking,
  withResolveRetry,
  workspaceRuntimeTarget
} from '@/lib/session-chain-support'
import {
  reconcileLaunchedSessionChainStep,
  type SessionChainLaunchAccess
} from '@/lib/session-chain-launch-reconciliation'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { isShellProcess } from '../../../shared/shell-process-detection'
import {
  sessionChainPredecessors,
  sessionChainStepOutputDir,
  isLiveSessionChain,
  type SessionChain,
  type SessionChainStep
} from '../../../shared/session-chain-types'
import { evaluateSessionEffortParity } from '../../../shared/session-effort-parity'
import { supportedEffortsForAgentModel } from '../../../shared/session-effort-support'
import { sessionChainLaunchDefinition } from './session-chain-launch-admission'

export type { SessionChainLaunchAccess } from './session-chain-launch-reconciliation'

// Why: the prompt lands and the agent needs a moment to start working; arming the idle
// wait before the agent reported `working` would read the fresh session as finished.
const WORKING_OBSERVATION_TIMEOUT_MS = 180_000
const POST_DELIVERY_GRACE_MS = 3_000
// Why: a CLI that exits right after launch (a first-run prompt swallowed the
// instruction, an expired sign-in) never reports working; waiting on its idle would
// hide the cause for minutes. Two readings of a shell in the foreground fail the step.
const LIVENESS_POLL_MS = 5_000
const LIVENESS_STRIKES = 2

async function readPreviousOutput(
  chain: SessionChain,
  sourceHandles: readonly string[],
  signal: AbortSignal
): Promise<string> {
  // Why: the first step reads the conversation it was launched from, which may live in another workspace.
  const worktreeId = sessionChainPredecessors(chain, chain.currentIndex).length
    ? chain.worktreeId
    : (chain.sourceWorktreeId ?? chain.worktreeId)
  // Why: a step never launches without the context it was told to continue; the failure must surface.
  const tails = await Promise.all(
    sourceHandles.map((sourceHandle, index) =>
      readSessionWorkOutput(
        { ...chain, worktreeId },
        sourcePaneKeysForStep(chain, chain.currentIndex)[index],
        sourceHandle,
        signal
      )
    )
  )
  // Why: after a fan-out the next step reads every branch; each tail keeps its own heading.
  return tails.length === 1
    ? (tails[0] ?? '')
    : tails
        .map((tail, index) => `--- Result ${index + 1} of ${tails.length} ---\n${tail}`)
        .join('\n\n')
}

async function readPreviousFiles(chain: SessionChain): Promise<string[]> {
  const previous = sessionChainPredecessors(chain, chain.currentIndex)
  // Why: the local output-files RPC cannot read SSH paths; the next agent reads its host's manifests.
  if (chain.placement?.startsWith('ssh:')) {
    return previous.map(
      (step) => `${sessionChainStepOutputDir(chain.workspacePath, chain.id, step.id)}/manifest.md`
    )
  }
  const files = await Promise.all(
    previous.map(async (step) => {
      try {
        const result = await listSessionChainOutputFilesFromHost(
          workspaceRuntimeTarget(chain.worktreeId),
          {
            workspacePath: chain.workspacePath,
            chainId: chain.id,
            stepId: step.id
          }
        )
        return result.files
      } catch (error) {
        console.warn('[session-chain] previous step files unavailable', error)
        return []
      }
    })
  )
  return files.flat()
}

async function pollLaunchedAgent(
  chain: SessionChain,
  launchedPaneKey: string,
  signal: AbortSignal
): Promise<never> {
  const deps = withResolveRetry(
    createTerminalWaitDependencies(
      workspaceRuntimeTarget(chain.worktreeId),
      { sourcePaneKey: launchedPaneKey, worktreeId: chain.worktreeId },
      signal
    ),
    signal
  )
  const never = new Promise<never>(() => {})
  if (!deps.foregroundProcess) {
    return never
  }
  const { handle } = await deps.resolveSource()
  let strikes = 0
  while (!signal.aborted) {
    await sleepUnlessAborted(LIVENESS_POLL_MS, signal)
    if (signal.aborted) {
      break
    }
    const foreground = await deps.foregroundProcess(handle)
    strikes = foreground && isShellProcess(foreground) ? strikes + 1 : 0
    if (strikes >= LIVENESS_STRIKES) {
      throw new Error(
        translate(
          'components.sessionChain.launchedAgentExited',
          "The next session's agent exited before it started working ({{process}} is in the foreground). Check that account's CLI for first-run prompts, then queue again.",
          { process: foreground ?? '' }
        )
      )
    }
  }
  return never
}

/** Resolve once the launched agent reports working; reject as soon as it is seen to have exited. */
async function observeLaunchedAgent(
  chain: SessionChain,
  launchedPaneKey: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return false
  }
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  signal.addEventListener('abort', stop)
  try {
    return await Promise.race([
      waitForPaneAgentWorking(launchedPaneKey, controller.signal, WORKING_OBSERVATION_TIMEOUT_MS),
      pollLaunchedAgent(chain, launchedPaneKey, controller.signal)
    ])
  } finally {
    controller.abort()
    signal.removeEventListener('abort', stop)
  }
}

/**
 * Launch the chain's current step: read the previous session's tail and produced
 * files, render the step's instruction, start the agent with its actor, then record
 * the pane the next step will wait on.
 */
export async function launchSessionChainStep(
  access: SessionChainLaunchAccess,
  sourceHandles: readonly string[],
  signal: AbortSignal
): Promise<void> {
  const chain = access.getChain()
  const step = chain?.steps[chain.currentIndex]
  if (!chain || !step || step.kind === 'handoff' || signal.aborted) {
    return
  }
  const definition = sessionChainLaunchDefinition(chain)
  const shouldLaunch = (): boolean => {
    const current = access.getChain()
    return Boolean(
      !signal.aborted &&
      current &&
      !current.outcomeSet &&
      isLiveSessionChain(current) &&
      definition !== null &&
      sessionChainLaunchDefinition(current) === definition &&
      current.steps[current.currentIndex]?.status === 'queued'
    )
  }
  if (chain.placement) {
    const state = useAppStore.getState()
    const workspace = state.getKnownWorktreeById(chain.worktreeId, chain.placement)
    if (
      !workspace ||
      getWorktreeExecutionHostId(
        workspace,
        state.repos.find((repo) => repo.id === workspace.repoId)
      ) !== chain.placement
    ) {
      throw new Error(
        translate(
          'nextStep.placementUnavailable',
          'The selected computer’s workspace is no longer available. Add it under Workspaces (🔧) and try again.'
        )
      )
    }
  }
  access.update({ state: 'launching' })
  const settings = useAppStore.getState().settings
  const [previousOutput, previousFiles] = await Promise.all([
    readPreviousOutput(chain, sourceHandles, signal),
    readPreviousFiles(chain)
  ])
  // Preparation can outlive cancellation; check the current obligation before launching.
  if (!shouldLaunch()) {
    return
  }
  const { prompt } = buildSessionChainStepPrompt({
    settings,
    chain,
    step,
    previousOutput,
    previousFiles
  })
  const { launchPreferences, launchEnv } = resolveSessionActorLaunch(settings, step.agent, {
    model: step.model,
    openrouterCandidates: step.openrouterCandidates,
    effort: step.effort,
    accountChoiceId: step.accountChoiceId
  })
  // What this step asked for beside what its launch actually carries: an effort without a
  // model is dropped by the launch contract, and a level the model does not advertise is
  // refused rather than stepped down. Either way the step records both values.
  const effortParity = evaluateSessionEffortParity({
    requested: { model: step.model, effort: step.effort },
    applied: { model: launchPreferences?.model, effort: launchPreferences?.effort },
    supportedEfforts: supportedEffortsForAgentModel(step.agent, step.model)
  })
  // Why: a new tab's terminal mounts, and spawns its agent, only inside the active
  // workspace. A chain queued in a background workspace would otherwise create a
  // tab that never opens a pane and fail after the pane-key timeout.
  if (useAppStore.getState().activeWorktreeId !== chain.worktreeId) {
    activateAndRevealWorkspace(chain.worktreeId)
  }
  let launched: {
    tabId: string | null
    promptDelivered: Promise<boolean>
  } | null = null
  const ok = await launchAgentSessionContinuation({
    agent: step.agent,
    prompt,
    worktreeId: chain.worktreeId,
    workspacePath: chain.workspacePath,
    initialCwd: chain.workspacePath,
    launchSource: 'sidebar',
    launchPreferences,
    launchEnv,
    shouldLaunch,
    onLaunched: (result) => {
      launched = result
    }
  })
  const result = launched as {
    tabId: string | null
    promptDelivered: Promise<boolean>
  } | null
  if (!ok && !shouldLaunch()) {
    return
  }
  if (!ok || !result) {
    throw new Error('The next session could not be started.')
  }
  const launchedTabId = result.tabId
  if (!launchedTabId) {
    throw new Error('The next session opened on a paired host and cannot be chained here.')
  }
  // The launch primitive cannot be cancelled once entered. Persist its tab receipt before a pane
  // wait or cancellation check, or a restored chain would treat this real session as queued.
  const current = access.getChain()
  if (!current || sessionChainLaunchDefinition(current) !== definition) {
    return
  }
  const steps: SessionChainStep[] = current.steps.map((candidate, index) =>
    index === chain.currentIndex && candidate.kind !== 'handoff'
      ? {
          ...candidate,
          status: 'launched',
          launchedTabId,
          launchedAt: Date.now(),
          effortParity
        }
      : candidate
  )
  const next = access.update({
    steps,
    state: 'waiting'
  })
  if (next) {
    await access.persist(next)
  }
  await reconcileLaunchedSessionChainStep(access, signal)
  const launchedStep = access.getChain()?.steps[chain.currentIndex]
  const launchedPaneKey =
    launchedStep && launchedStep.kind !== 'handoff' ? launchedStep.launchedPaneKey : undefined
  if (!launchedPaneKey || signal.aborted) {
    return
  }
  const delivered = await result.promptDelivered
  if (signal.aborted) {
    return
  }
  if (!delivered) {
    throw new Error('The next session started, but its instruction could not be sent.')
  }
  toast.success(translate('auto.components.SessionSidebar.startedToast', 'Queued session started.'))
  const observedWorking = await observeLaunchedAgent(chain, launchedPaneKey, signal)
  if (signal.aborted) {
    return
  }
  if (!observedWorking) {
    console.warn('[session-chain] launched session never reported working; waiting on idle anyway')
  }
  await sleepUnlessAborted(POST_DELIVERY_GRACE_MS, signal)
}
