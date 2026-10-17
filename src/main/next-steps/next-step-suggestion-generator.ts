/**
 * One suggester call: the Prompt Engineer's read-only one-shot runner (`claude -p --permission-mode
 * plan` or `codex exec --ephemeral -s read-only`), on the workspace's own host, asked one bounded
 * question about the turn that just finished.
 */

import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import { briefOneShotAgent } from '../../shared/assisted-brief-actors'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { NextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import {
  buildNextStepSuggestionPrompt,
  NEXT_STEP_DIFF_STAT_MAX,
  NEXT_STEP_TURN_SUGGESTION_MAX,
  type NextStepGitFacts,
  type NextStepGitFactsUnavailable
} from '../../shared/next-step-suggestion-prompt'
import { parseNextStepSuggestionOutput } from '../../shared/next-step-suggestion-output'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { Store } from '../persistence'
import { resolveBriefTarget } from '../ipc/assisted-brief'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import {
  cancelNextStepSuggestionTextLocal,
  generateNextStepSuggestionTextFromPrompt
} from '../text-generation/commit-message-text-generation'
import type { NextStepGenerateOutcome } from './next-step-suggestion-service'
import type { FinishedTurn } from './next-step-turn-signal'
import { nextStepWorkspaceLane, resolveNextStepWorkspace } from './next-step-workspace'

export const NEXT_STEP_OPERATION = 'next-step-suggestions'
const runningOwners = new Map<string, symbol>()

export const PAIRED_HOST_REASON =
  'Suggested next steps run on this computer or an SSH host; this workspace lives on a paired host.'

/** Branch, upstream and per-path line counts from the host-aware status read; never throws. */
export async function readNextStepGitFacts(
  readGitStatus: (worktreeId: string) => Promise<GitStatusResult>,
  worktreeId: string
): Promise<NextStepGitFacts | NextStepGitFactsUnavailable> {
  let status: GitStatusResult
  try {
    status = await readGitStatus(worktreeId)
  } catch (error) {
    console.warn('[next-steps] git facts unavailable for', worktreeId, error)
    return { unavailable: true }
  }
  let diffStat = ''
  for (const entry of status.entries) {
    const counts =
      entry.added !== undefined || entry.removed !== undefined
        ? ` | +${entry.added ?? 0} -${entry.removed ?? 0}`
        : ''
    const line = `${entry.status} ${entry.path}${counts}\n`
    if (diffStat.length + line.length > NEXT_STEP_DIFF_STAT_MAX) {
      diffStat += '…\n'
      break
    }
    diffStat += line
  }
  const upstream = status.upstreamStatus
  return {
    ...(status.branch ? { branch: status.branch } : {}),
    upstream: upstream?.hasUpstream ? { ahead: upstream.ahead, behind: upstream.behind } : null,
    changedFiles: status.statusLength ?? status.entries.length,
    diffStat
  }
}

/**
 * The one-shot CLI that writes suggestions: the setting, else the conversation's own agent, else
 * Claude when that agent has no one-shot runner (Grok, Gemini, …) — before this, every Grok turn
 * failed with "Choose Claude or Codex" and its sessions never got suggestions.
 */
export function resolveNextStepActor(
  settings: NextStepSuggestionSettings,
  workingAgent: string | undefined
): { agent: TuiAgent; model: string } | { error: string } {
  const own = isTuiAgent(workingAgent) ? workingAgent : undefined
  const wanted = settings.agent ?? own
  const agent =
    (wanted ? briefOneShotAgent(wanted) : null) ??
    (!settings.agent && own ? briefOneShotAgent('claude') : null)
  const spec = agent ? getCommitMessageAgentSpec(agent) : undefined
  if (!agent || !spec) {
    return {
      error: `${workingAgent ?? 'This agent'} cannot suggest next steps. Choose Claude or Codex for suggestions in settings.`
    }
  }
  return { agent, model: settings.model ?? spec.defaultModelId }
}

export type NextStepGeneratorDeps = {
  store: Pick<Store, 'getRepo' | 'getFolderWorkspaces' | 'getSettings'>
  settings: () => NextStepSuggestionSettings
  agentEnv?: () => CommitMessageAgentEnvironmentResolvers | undefined
  readGitStatus: (worktreeId: string) => Promise<GitStatusResult>
  generateText?: typeof generateNextStepSuggestionTextFromPrompt
}

/** What the suggester is told beyond the turn itself. */
export type NextStepTurnContext = {
  /** The conversation's goal (`NextStepJev.goalFor`). */
  goal?: string | null
  /** The reply's own proposed step titles, on an explicit request for more. */
  proposedSteps?: readonly string[]
}

export async function generateNextSteps(
  deps: NextStepGeneratorDeps,
  turn: FinishedTurn,
  signal: AbortSignal,
  context: NextStepTurnContext = {}
): Promise<NextStepGenerateOutcome> {
  const workingSpec = isTuiAgent(turn.agent) ? getCommitMessageAgentSpec(turn.agent) : undefined
  const outcome = await runNextStepSuggester(
    deps,
    { worktreeId: turn.conversation.worktreeId, workingAgent: turn.agent },
    (git) =>
      buildNextStepSuggestionPrompt({
        ...(workingSpec ? { agentLabel: workingSpec.label } : {}),
        ...(context.goal ? { goal: context.goal } : {}),
        ...(turn.lastUserPrompt ? { lastUserPrompt: turn.lastUserPrompt } : {}),
        lastAssistantMessage: turn.lastAssistantMessage,
        ...(git ? { git } : {}),
        ...(context.proposedSteps?.length ? { proposedSteps: context.proposedSteps } : {})
      }),
    signal
  )
  return outcome.ok
    ? { ...outcome, suggestions: outcome.suggestions.slice(0, NEXT_STEP_TURN_SUGGESTION_MAX) }
    : outcome
}

/**
 * One suggester call in a workspace: the actor, the workspace's git facts (none for a folder),
 * the read-only runner and the shared output parsing. `buildPrompt` is the only thing a caller
 * decides, so turn and start suggestions share every guard.
 */
export async function runNextStepSuggester(
  deps: NextStepGeneratorDeps,
  request: { worktreeId: string; workingAgent: string | undefined },
  buildPrompt: (git: NextStepGitFacts | NextStepGitFactsUnavailable | undefined) => string,
  signal: AbortSignal
): Promise<NextStepGenerateOutcome> {
  const workspace = resolveNextStepWorkspace(deps.store, request.worktreeId)
  if (!workspace) {
    return { ok: false, error: PAIRED_HOST_REASON }
  }
  const actor = resolveNextStepActor(deps.settings(), request.workingAgent)
  if ('error' in actor) {
    return { ok: false, error: actor.error }
  }
  const git = workspace.git
    ? await readNextStepGitFacts(deps.readGitStatus, request.worktreeId)
    : undefined
  const prompt = buildPrompt(git)
  const envResolvers = deps.agentEnv?.()
  const target = await resolveBriefTarget(
    { store: deps.store as Store, ...(envResolvers ? { agentEnv: envResolvers } : {}) },
    {
      worktreePath: workspace.path,
      ...(workspace.connectionId ? { connectionId: workspace.connectionId } : {}),
      agent: actor.agent
    }
  ).catch((): { error: string } => ({
    error: 'This workspace could not be opened for suggestions.'
  }))
  if ('error' in target) {
    return { ok: false, error: target.error }
  }
  if (signal.aborted) {
    return { ok: false, error: 'Suggestions were cancelled.' }
  }
  // Why: the runner cancels by (operation, cwd); only the call that owns that key may cancel it,
  // so aborting one conversation can never kill another's call in the same workspace.
  const ownerKey = nextStepWorkspaceLane(workspace)
  const owner = Symbol(ownerKey)
  runningOwners.set(ownerKey, owner)
  const cancel = (): void => {
    if (runningOwners.get(ownerKey) !== owner) {
      return
    }
    if (target.kind === 'local') {
      cancelNextStepSuggestionTextLocal(target.cwd)
    } else if (workspace.connectionId) {
      void getSshGitProvider(workspace.connectionId)
        ?.cancelNonInteractiveExec(target.cwd, NEXT_STEP_OPERATION)
        .catch(() => {})
    }
  }
  signal.addEventListener('abort', cancel, { once: true })
  const override = deps.store.getSettings().agentCmdOverrides?.[actor.agent]?.trim()
  try {
    const result = await (deps.generateText ?? generateNextStepSuggestionTextFromPrompt)(
      prompt,
      {
        agentId: actor.agent,
        model: actor.model,
        ...(override ? { agentCommandOverride: override } : {})
      },
      target
    )
    if (!result.success) {
      return { ok: false, error: result.error }
    }
    const parsed = parseNextStepSuggestionOutput(result.rawOutput)
    return parsed.ok
      ? {
          ok: true,
          suggestions: parsed.suggestions,
          model: actor.model || result.agentLabel,
          ...(git ? { git } : {})
        }
      : { ok: false, error: parsed.error }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (runningOwners.get(ownerKey) === owner) {
      runningOwners.delete(ownerKey)
    }
  }
}
