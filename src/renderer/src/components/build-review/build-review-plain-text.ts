import { translate } from '@/i18n/i18n'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../../shared/build-review-pipeline'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

// Identifiers the runtime writes into its own lines, in their exact shapes: orchestration ids
// (`run_`, `ctx_`, `task_`, `msg_`, `brp_` and 12 hex digits), terminal handles (`term_` and a
// UUID), board cards (`btk_…`) and `id:<repo>::<path>` workspace selectors. Exact, so that a word
// such as `task_runner` in an agent's own sentence is left alone.
const GENERATED_ID = /\b(?:run|ctx|task|msg|delivery|dispatch|brp)_[0-9a-f]{12}\b/g
const TERMINAL_HANDLE = /\bterm_(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/g
const BOARD_CARD = /\bbtk_[A-Za-z0-9]{4,64}\b/g
const WORKSPACE_SELECTOR = /\bid:\S+/g

const STARTUP_BLOCKED = /Agent startup blocked: ([a-z-]+)/
const PROMPT_STALLED = /\bagent_prompt_(?:stalled|blocked)\b/
const WORKSPACE_HELD = /still owns this workspace/
// The host refusing a second run while one is going (`build-review-service.ts`).
const WORKSPACE_BUSY =
  /\bPipeline (?:\S+ )?is still (?:starting|building|reviewing) in this workspace\b/

export function withoutIdentifiers(text: string): string {
  const stripped = text
    .replace(WORKSPACE_SELECTOR, '')
    .replace(GENERATED_ID, '')
    .replace(TERMINAL_HANDLE, '')
    .replace(BOARD_CARD, '')
  if (stripped === text) {
    return text
  }
  return stripped
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,:;])/g, '$1')
    .trim()
}

function agentName(agent: string | undefined): string {
  return agent && isTuiAgent(agent)
    ? TUI_AGENT_DISPLAY_NAMES[agent]
    : translate('buildReview.plain.theAgent', 'The agent')
}

/** What a startup prompt asks of the person, by the runtime's blocker id. */
export function startupBlockerSentence(blocker: string, agent?: string): string {
  const name = agentName(agent)
  switch (blocker) {
    case 'claude-folder-trust':
      return translate(
        'buildReview.blocker.claudeTrust',
        'Claude is asking whether to trust this folder — open the terminal to answer.'
      )
    case 'codex-hooks-review-prompt':
      return translate(
        'buildReview.blocker.codexHooks',
        'Codex found new or changed hooks and wants you to review them — open the terminal to answer.'
      )
    // Why the agent's name: the runtime files Claude's folder-trust dialog under this id too.
    case 'codex-trust-workspace':
      return translate(
        'buildReview.blocker.trustFolder',
        '{{agent}} is asking whether to trust this folder — open the terminal to answer.',
        { agent: name }
      )
    case 'codex-update-prompt':
      return translate(
        'buildReview.blocker.codexUpdate',
        'Codex is offering an update — open the terminal to answer.'
      )
    case 'agent-prompt-stalled':
      return translate(
        'buildReview.blocker.stalled',
        '{{agent}} did not start on its task. Open the terminal to see what it is waiting for.',
        { agent: name }
      )
    default:
      return translate(
        'buildReview.blocker.waiting',
        '{{agent}} is waiting for an answer before it can start — open the terminal to answer.',
        { agent: name }
      )
  }
}

/** A runtime failure line in words: startup prompts named, internal ids left out. */
export function plainFailureText(text: string, agent?: string): string {
  const blocked = STARTUP_BLOCKED.exec(text)?.[1]
  if (blocked) {
    return startupBlockerSentence(blocked, agent)
  }
  if (PROMPT_STALLED.test(text)) {
    return startupBlockerSentence('agent-prompt-stalled', agent)
  }
  if (WORKSPACE_HELD.test(text)) {
    return translate(
      'buildReview.plain.workspaceHeld',
      'An earlier Build + Review run still holds this workspace.'
    )
  }
  if (WORKSPACE_BUSY.test(text)) {
    return translate(
      'buildReview.plain.workspaceBusy',
      'A Build + Review run is already working in this workspace. Stop it or wait for it to finish.'
    )
  }
  return withoutIdentifiers(text)
}

/** The worker card's one line about what went wrong, or null when nothing did. */
export function workerProblemText(worker: BuildReviewWorkerSnapshot): string | null {
  if (worker.startupBlocker) {
    return startupBlockerSentence(worker.startupBlocker, worker.choice.agent)
  }
  return worker.error ? plainFailureText(worker.error, worker.choice.agent) : null
}

/** The run's banner line: which worker could not start and why, or the failure in words. */
export function pipelineProblemText(pipeline: BuildReviewPipelineSnapshot): string | null {
  if (!pipeline.error) {
    return null
  }
  const workers = [pipeline.builder, ...(pipeline.reviewers ?? [pipeline.reviewer])]
  const blocked = workers.find((worker) => worker.startupBlocker)
  if (blocked?.startupBlocker) {
    const lead =
      blocked.role === 'builder'
        ? translate('buildReview.plain.builderBlocked', 'The builder could not start.')
        : translate('buildReview.plain.reviewerBlocked', 'A reviewer could not start.')
    return `${lead} ${startupBlockerSentence(blocked.startupBlocker, blocked.choice.agent)}`
  }
  const role = /^(builder|reviewer): /.exec(pipeline.error)?.[1]
  const agent = role === 'builder' ? pipeline.builder.choice.agent : undefined
  return plainFailureText(pipeline.error.replace(/^(?:builder|reviewer): /, ''), agent)
}
