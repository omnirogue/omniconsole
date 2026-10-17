// Kill switch for quiet background agent runs (`quietBackgroundAgentRuns` setting, default on).
//
// Why a reader and not the store: the text-generation and session-search modules stay
// decoupled from persistence. Main startup installs a reader over the settings store; until
// then (and in tests) the default is on, matching the setting's default.
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import {
  CLAUDE_ISOLATED_HEADLESS_ENV,
  withClaudeIsolatedHeadlessArgs
} from '../../shared/claude-isolated-headless'
import type { TextGenerationOperation } from './source-control-text-generation-types'

// Why `undefined` is allowed: an unset setting means the default, which is on.
let readEnabled: () => boolean | undefined = () => true

export function setQuietBackgroundAgentRunsReader(reader: () => boolean | undefined): void {
  readEnabled = reader
}

/** Never throws: a failing reader counts as the default (on). */
export function isQuietBackgroundAgentRunsEnabled(): boolean {
  try {
    return readEnabled() !== false
  } catch {
    return true
  }
}

export function _resetQuietBackgroundAgentRunsReaderForTests(): void {
  readEnabled = () => true
}

/** One-shot runs whose prompt already carries everything they read (diff, transcript, task). */
const TOOL_FREE_OPERATIONS: ReadonlySet<string> = new Set<TextGenerationOperation>([
  'commit-message',
  'pull-request-fields',
  'branch-name',
  'session-summary'
])

/**
 * The plan a background Claude one-shot runs: the isolated recipe (no hooks, MCP servers,
 * settings files, slash commands or transcript) plus its environment. Other agents, a custom
 * command and the switch turned off keep the plan as built. Why not on a local Windows host, and
 * without the inline MCP config on a remote one: that config is JSON, which a `.cmd` shim refuses
 * as unsafe batch input, and a remote host may run Windows.
 */
export function quietBackgroundAgentPlan(
  agentId: string,
  plan: CommitMessagePlan,
  operation: TextGenerationOperation | 'model-discovery',
  where: { remote: boolean }
): CommitMessagePlan {
  if (
    agentId !== 'claude' ||
    (!where.remote && process.platform === 'win32') ||
    !isQuietBackgroundAgentRunsEnabled()
  ) {
    return plan
  }
  return {
    ...plan,
    // Why tools stay for the rest: session prep, briefs and next steps read the workspace. A
    // model listing answers one control request and never starts a turn.
    args: withClaudeIsolatedHeadlessArgs(plan.args, {
      noTools: TOOL_FREE_OPERATIONS.has(operation),
      batchSafe: where.remote
    }),
    env: { ...plan.env, ...CLAUDE_ISOLATED_HEADLESS_ENV }
  }
}

/** The spawn environment for a plan: its own variables over the caller's (or this process's). */
export function planSpawnEnv(
  plan: Pick<CommitMessagePlan, 'env'>,
  env: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv | undefined {
  return plan.env ? { ...(env ?? process.env), ...plan.env } : env
}
