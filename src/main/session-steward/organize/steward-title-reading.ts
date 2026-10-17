/**
 * What re-titling reads about a session (Phase 3 §2), from one transcript tail read: the goal in
 * progress (the last of its pull-request goals, `sessionGoalGroups`), the latest finished turn and
 * instruction, and the task card the conversation executes.
 */

import { isTextBlock, type NativeChatMessage } from '../../../shared/native-chat-types'
import type { SessionGoalGroup } from '../../../shared/session-goal-groups'
import { sessionGoalGroups } from '../../../shared/session-goal-groups'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import { isSessionManageMarkedPrompt } from '../../../shared/session-manage-types'
import { sessionGoalFromPrompt } from '../../../shared/session-goal'
import {
  sessionPullRequestKey,
  type SessionPullRequestFacts
} from '../../../shared/session-pull-request-facts'
import { sessionPullRequestMentions } from '../../../shared/session-pull-request-refs'
import { resolveLocalAiVaultSessionTitles } from '../../ai-vault/session-title-resolver'
import { readConsoleTaskCard } from '../../backoffice/console-session-task'
import { readSessionPullRequestFacts } from '../../github/session-pull-request-facts'
import { decodeClaudeTranscriptLine } from '../../native-chat/transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from '../../native-chat/transcript-line-decoders-codex'
import { readNativeChatTranscriptTailFile } from '../../native-chat/transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from '../../native-chat/transcript-turn-lifecycle'
import type { OrcaRuntimeService } from '../../runtime/omni-runtime'
import { latestTurnFromMessages } from '../../session-manage/session-manage-first-turn'
import type { StewardSessionGoal, StewardTitleReading } from './steward-retitle'

const TAIL_MESSAGES = 400

/** The goal in progress, named after its first PR; null with no PR goal yet. */
export function stewardGoalOf(groups: readonly SessionGoalGroup[]): StewardSessionGoal | null {
  const current = groups.at(-1)
  const first = current?.pullRequests[0]
  return current && first
    ? {
        key: current.key,
        index: groups.length - 1,
        title: current.title,
        cause: `PR #${first.number} opened`
      }
    : null
}

/** The person's latest instruction in the tail. */
export function latestInstruction(messages: readonly NativeChatMessage[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role !== 'user') {
      continue
    }
    const text = message.blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('\n')
      .trim()
    // Why skip marked prompts: another session's or the steward's words are not an instruction.
    const instruction = isSessionManageMarkedPrompt(text) ? null : sessionGoalFromPrompt(text)
    if (instruction) {
      return instruction.full
    }
  }
  return null
}

async function pullRequestGoal(
  messages: readonly NativeChatMessage[]
): Promise<StewardSessionGoal | null> {
  const mentions = sessionPullRequestMentions(messages)
  const facts = new Map<string, SessionPullRequestFacts>()
  for (const mention of mentions) {
    const pr = await readSessionPullRequestFacts({
      owner: mention.owner,
      repo: mention.repo,
      number: mention.number
    })
    if (pr) {
      facts.set(sessionPullRequestKey(pr), pr)
    }
  }
  return stewardGoalOf(sessionGoalGroups(mentions, facts))
}

/** The card the conversation executes; null with none, a Jira task, or an unreadable card. */
async function taskCard(
  runtime: Pick<OrcaRuntimeService, 'listSessionChains'>,
  paneKey: string
): Promise<StewardTitleReading['card']> {
  const taskId = runtime
    .listSessionChains()
    .find((chain) => chain.sourcePaneKey === paneKey && chain.outcomeSet?.continuation.taskId)
    ?.outcomeSet?.continuation.taskId
  if (!taskId || taskId.startsWith('jira:')) {
    return null
  }
  const card = await readConsoleTaskCard({ taskId })
  return card.ok ? { key: `${taskId}\n${card.data.title}`, title: card.data.title } : null
}

/** The agent's own title for the session; null when it has none yet or it cannot be read. */
async function agentTitle(
  agent: 'claude' | 'codex',
  session: { id: string; transcriptPath: string }
): Promise<string | null> {
  const { titles } = await resolveLocalAiVaultSessionTitles([
    { agent, sessionId: session.id, transcriptPath: session.transcriptPath }
  ])
  return titles.find((title) => title.sessionId === session.id)?.title.trim() || null
}

export async function readStewardTitleReading(
  runtime: Pick<OrcaRuntimeService, 'getLastAgentHookRowForPane' | 'listSessionChains'>,
  row: Pick<SessionManageSidebarRow, 'paneKey' | 'agent'>
): Promise<StewardTitleReading | null> {
  const session = row.paneKey
    ? runtime.getLastAgentHookRowForPane(row.paneKey)?.providerSession
    : null
  if (
    !row.paneKey ||
    !session?.transcriptPath ||
    (row.agent !== 'claude' && row.agent !== 'codex')
  ) {
    return null
  }
  const tail = await readNativeChatTranscriptTailFile(
    session.transcriptPath,
    TAIL_MESSAGES,
    row.agent === 'claude' ? decodeClaudeTranscriptLine : decodeCodexTranscriptLine,
    false,
    undefined,
    nativeChatTurnLifecycleDecoderForAgent(row.agent)
  )
  const turn = latestTurnFromMessages(tail.messages, tail.lifecycle?.state ?? null)
  return {
    goal: await pullRequestGoal(tail.messages),
    turn:
      turn.complete && turn.turnKey && turn.text ? { key: turn.turnKey, text: turn.text } : null,
    instruction: latestInstruction(tail.messages),
    card: await taskCard(runtime, row.paneKey).catch(() => null),
    aiTitle: await agentTitle(row.agent, {
      id: session.id,
      transcriptPath: session.transcriptPath
    }).catch(() => null)
  }
}
