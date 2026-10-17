import { translate } from '@/i18n/i18n'

type Rule = { pattern: RegExp; text: () => string }

/** Machine codes and host phrasings a person may meet on a run, each with plain words. */
const RULES: readonly Rule[] = [
  {
    pattern: /\bagent_prompt_stalled\b/,
    text: () =>
      translate(
        'localWorkflow.error.promptStalled',
        'The agent stopped responding before it started the task.'
      )
  },
  {
    pattern: /\bagent_prompt_blocked\b/,
    text: () =>
      translate(
        'localWorkflow.error.promptBlocked',
        'The agent was waiting on a question in its terminal and could not start the task.'
      )
  },
  {
    pattern: /\bterminal_not_writable\b/,
    text: () =>
      translate('localWorkflow.error.terminalNotWritable', 'The terminal no longer accepts input.')
  },
  {
    pattern: /\bagent_session_exited_during_start\b/,
    text: () =>
      translate('localWorkflow.error.exitedDuringStart', 'The agent exited while it was starting.')
  },
  {
    pattern: /\bcodex-hooks-review-prompt\b/,
    text: () =>
      translate(
        'localWorkflow.error.codexHooks',
        'Codex wants its hooks reviewed before it starts. Open Codex once to approve them, then retry.'
      )
  },
  {
    pattern: /\b(?:schema mismatch|never matched its schema)\b/i,
    text: () =>
      translate('localWorkflow.error.schema', "The agent's answer was not in the expected format.")
  },
  {
    pattern: /\bworkflow provider did not return a successful result\b/i,
    text: () =>
      translate('localWorkflow.error.noResult', 'The agent ended without giving a result.')
  },
  {
    pattern: /\bworkflow provider did not finish the turn\b/i,
    text: () => translate('localWorkflow.error.unfinished', 'The agent stopped before it finished.')
  },
  {
    pattern: /\berror_max_turns\b/,
    text: () =>
      translate('localWorkflow.error.maxTurns', 'The agent ran out of turns before it finished.')
  },
  {
    pattern: /\berror_during_execution\b/,
    text: () =>
      translate('localWorkflow.error.duringExecution', 'The agent hit an error while it worked.')
  }
]

/** A bare identifier such as `agent_prompt_stalled` or `worker-exit`: a code, not a sentence. */
const BARE_CODE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/

/**
 * Where the words appear: on an agent's card, on the run itself (both with a Details toggle that
 * holds the raw report), or inside Details, where an unknown code is itself the report.
 */
export type WorkflowErrorPlace = 'call' | 'run' | 'details'

function unknownCodeText(place: Exclude<WorkflowErrorPlace, 'details'>): string {
  return place === 'run'
    ? translate(
        'localWorkflow.error.unknownRunCode',
        'The run stopped unexpectedly. Details has the full report.'
      )
    : translate(
        'localWorkflow.error.unknownCode',
        'The agent stopped unexpectedly. Details has the full report.'
      )
}

/**
 * What a person reads for a host or provider error: plain words for a known code, a generic line
 * for any other bare code, and the host's own sentence otherwise. The raw text stays in Details.
 */
export function workflowErrorText(raw: string, place: WorkflowErrorPlace = 'call'): string {
  const message = raw.trim().replace(/^[a-z]+(?:[_-][a-z]+)*:\s+(?=[a-z_-]+$)/, '')
  const known = RULES.find((rule) => rule.pattern.test(message))
  if (known) {
    return known.text()
  }
  if (BARE_CODE.test(message) && place !== 'details') {
    return unknownCodeText(place)
  }
  return raw.trim()
}

/** True when the words shown differ from what the host reported, so Details shows the original. */
export function workflowErrorWasTranslated(raw: string): boolean {
  return workflowErrorText(raw) !== raw.trim()
}
