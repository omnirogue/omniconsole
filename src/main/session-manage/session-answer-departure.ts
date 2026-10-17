import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { SessionManageEntry, SessionStateBasis } from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readScreenEvidence } from '../runtime/terminal-agent-evidence'
import type { PromptExitReading } from './session-answer-confirmation'
import type { SessionAnswerReading } from './session-manage-answer'
import { parseSessionPromptScreen, screenShowsPromptMenu } from './session-prompt-screen'

/**
 * What an `awaiting-user` state may rest on to be answered: a fresh hook report, the terminal
 * title, the rendered screen, or the chat host. `none` (unknown), `last-report` and `process`
 * are never positive evidence of a prompt waiting now.
 */
const POSITIVE_PROMPT_BASES: ReadonlySet<SessionStateBasis> = new Set([
  'hook',
  'title',
  'screen',
  'chat-host'
])

/** A state read from positive evidence now (see `POSITIVE_PROMPT_BASES`). */
export function positiveStateBasis(basis: SessionStateBasis): boolean {
  return POSITIVE_PROMPT_BASES.has(basis)
}

/** A positive reading that the session is live and at no prompt: working, idle and the like. */
export function positivelyAwayFromPrompt(
  entry: Pick<SessionManageEntry, 'verdict' | 'state' | 'stateBasis'>
): boolean {
  return (
    entry.verdict === 'live' &&
    entry.state !== 'awaiting-user' &&
    entry.state !== 'unknown' &&
    entry.state !== 'exited' &&
    positiveStateBasis(entry.stateBasis)
  )
}

/** The same positive departure predicate serves confirmation and quarantine release. */
export async function readSessionAnswerDeparture(
  read: () => Promise<SessionAnswerReading>,
  runtime: Pick<OrcaRuntimeService, 'readTerminal'>,
  row: SessionManageSidebarRow
): Promise<PromptExitReading> {
  const next = await read()
  const { verdict, state, stateBasis, terminal } = next.entry
  if (verdict !== 'live') {
    return { kind: 'unreadable', reason: `its terminal is ${verdict}` }
  }
  if (next.prompt || state === 'awaiting-user') {
    return { kind: 'waiting' }
  }
  if (!positivelyAwayFromPrompt(next.entry)) {
    return {
      kind: 'unreadable',
      reason: `its state after the key (${state}, from ${stateBasis}) is not positive evidence`
    }
  }
  if (row.kind === 'structured') {
    // The host resolves its journal before calling the provider, including failed delivery.
    // Its derived working/idle state and empty pending list cannot prove prompt departure.
    return {
      kind: 'unreadable',
      reason: 'its chat host has no verified provider departure receipt'
    }
  }
  if (!terminal) {
    return { kind: 'unreadable', reason: 'its terminal could not be read' }
  }
  const screen = await runtime.readTerminal(terminal, { screen: true, limit: 2000 })
  if (screen.source !== 'screen') {
    return { kind: 'unreadable', reason: 'its screen could not be read' }
  }
  const text = stripAnsiEscapeSequences(screen.tail.join('\n'))
  if (!text.trim()) {
    return { kind: 'unreadable', reason: 'its screen was empty' }
  }
  if (
    parseSessionPromptScreen(row.agent, text) ||
    screenShowsPromptMenu(text) ||
    /^\s*[❯›>]?\s*\d+[.)]\s/m.test(text) ||
    // Why not a quoted line: `› > question?` is a submitted answer echoing its question.
    text.split('\n').some((line) => /\?\s*$/.test(line) && !/^\s*[❯›]?\s*>\s/.test(line))
  ) {
    return { kind: 'waiting' }
  }
  // Absence of a menu is not evidence: require the existing detector's positive turn marker.
  const evidence = readScreenEvidence(text.split('\n'), {
    blockedReason: () => null,
    readyPrompt: () => false
  })
  return evidence.working || evidence.turnDone
    ? { kind: 'left' }
    : { kind: 'unreadable', reason: 'its screen showed no recognized departure from the prompt' }
}
