/**
 * JEV on suggested next steps: ranks and risk-checks each AI and parsed set (one call per set),
 * and reads how done the work is once per finished turn, after its suggestions. Everything here
 * fails open: with JEV off or unavailable the sets stay as written and there is no reading.
 *
 * Keep going takes `NextStepJev.assessDoneness` (settings-gated `assessNextStepDoneness`) by
 * injection; the reading it gets is the same cached one the tray shows.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { NextStepDoneness } from '../../shared/next-step-doneness'
import {
  nextStepAgentLabel,
  nextStepTranscriptBlock,
  type NextStepGitFacts,
  type NextStepGitFactsUnavailable
} from '../../shared/next-step-suggestion-prompt'
import {
  nextStepJevSettings,
  type NextStepSuggestionSettings
} from '../../shared/next-step-suggestion-settings'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { JevRankOptions } from '../structured-decisions/jev-rank'
import {
  assessNextStepDoneness,
  nextStepDonenessCache,
  type NextStepDonenessCache,
  type NextStepDonenessInput
} from './next-step-jev-doneness'
import { resolveNextStepGoal } from './next-step-jev-goal'
import { judgeNextStepImprovement } from './next-step-jev-improvement'
import { judgeNextStepSuggestions } from './next-step-jev-rank'
import type { NextStepKeepGoingJudges } from './next-step-keep-going-judge'
import { isKeepGoingPrompt } from './next-step-keep-going-rounds'
import type { NextStepStartGeneratorDeps } from './next-step-start-generator'
import type {
  NextStepGenerateOutcome,
  NextStepSuggestionService
} from './next-step-suggestion-service'
import type { FinishedTurn } from './next-step-turn-signal'

export { assessNextStepDoneness } from './next-step-jev-doneness'
export { resolveNextStepGoal } from './next-step-jev-goal'
export type { NextStepDonenessInput } from './next-step-jev-doneness'

const MAX_REMEMBERED = 500

export type NextStepJevDeps = {
  settings: () => NextStepSuggestionSettings
  readTaskCard?: NextStepStartGeneratorDeps['readTaskCard']
  jev?: JevRankOptions
  cache?: NextStepDonenessCache
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_REMEMBERED) {
    map.delete(map.keys().next().value!)
  }
}

/** A prompt the person wrote, trimmed; Keep going's own rounds are never the goal. */
const personPrompt = (prompt: string | undefined): string | undefined => {
  const trimmed = prompt?.trim()
  return trimmed && !isKeepGoingPrompt(trimmed) ? trimmed : undefined
}

/** The turn as the suggester saw it, for JEV to judge from. */
export function nextStepTurnText(
  turn: FinishedTurn,
  git?: NextStepGitFacts | NextStepGitFactsUnavailable
): string {
  const spec = isTuiAgent(turn.agent) ? getCommitMessageAgentSpec(turn.agent) : undefined
  return nextStepTranscriptBlock(
    {
      ...(turn.lastUserPrompt ? { lastUserPrompt: turn.lastUserPrompt } : {}),
      lastAssistantMessage: turn.lastAssistantMessage,
      ...(git ? { git } : {})
    },
    nextStepAgentLabel(spec?.label)
  )
}

export class NextStepJev {
  private service: NextStepSuggestionService | null = null
  private readonly taskLinks = new Map<string, string>()
  private readonly firstPrompts = new Map<string, string>()
  /** Parsed sets already sent to JEV (or skipped): each is judged at most once. */
  private readonly judgedParsed = new Set<string>()
  private readonly cache: NextStepDonenessCache

  constructor(private readonly deps: NextStepJevDeps) {
    this.cache = deps.cache ?? nextStepDonenessCache
  }

  attach(service: NextStepSuggestionService | null): void {
    this.service = service
  }

  private get switches() {
    return nextStepJevSettings(this.deps.settings())
  }

  /** Every finished turn: the first prompt this host sees in a conversation is its goal fallback. */
  noteTurn(turn: FinishedTurn): void {
    const key = conversationSourceRowKey(turn.conversation)
    const prompt = personPrompt(turn.lastUserPrompt)
    if (prompt && !this.firstPrompts.has(key)) {
      remember(this.firstPrompts, key, prompt)
    }
  }

  /** The hub card a client says this conversation serves; null unlinks. */
  linkTask(conversation: ConversationSource, taskId: string | null): void {
    const key = conversationSourceRowKey(conversation)
    if (taskId) {
      remember(this.taskLinks, key, taskId)
    } else {
      this.taskLinks.delete(key)
    }
  }

  /** The suggester's set, ranked and risk-checked before it is shown; doneness starts alongside. */
  async judgeGenerated(
    turn: FinishedTurn,
    outcome: NextStepGenerateOutcome,
    signal: AbortSignal
  ): Promise<NextStepGenerateOutcome> {
    if (signal.aborted) {
      return outcome
    }
    const git = outcome.ok ? outcome.git : undefined
    this.assessTurn(turn, git)
    const { rank, risk } = this.switches
    if (!outcome.ok || (!rank && !risk)) {
      return outcome
    }
    try {
      const judged = await judgeNextStepSuggestions(
        { turnText: nextStepTurnText(turn, git), suggestions: outcome.suggestions, rank, risk },
        this.deps.jev
      )
      // Cancelled or switched off while JEV read: the set stays as written.
      if (signal.aborted || !this.stillOn(rank, risk)) {
        return outcome
      }
      const { suggestions, ...marks } = judged
      return { ...outcome, suggestions, judged: marks }
    } catch (error) {
      console.warn('[next-steps] JEV ranking failed; kept the set as written', error)
      return outcome
    }
  }

  /** A switch turned off while JEV was reading voids that reading. */
  private stillOn(rank: boolean, risk: boolean): boolean {
    const now = this.switches
    return (!rank || now.rank) && (!risk || now.risk)
  }

  /** A parsed set is shown at once; JEV reorders and risk-checks it after, if it is still open. */
  onSetsChanged(): void {
    const service = this.service
    const { rank, risk } = this.switches
    if (!service || (!rank && !risk)) {
      return
    }
    for (const set of service.deps.store.list()) {
      if (set.origin !== 'parsed' || set.status !== 'pending' || this.judgedParsed.has(set.id)) {
        continue
      }
      this.judgedParsed.add(set.id)
      if (this.judgedParsed.size > MAX_REMEMBERED * 4) {
        this.judgedParsed.delete(this.judgedParsed.values().next().value!)
      }
      const turn = this.turnOf(service, set)
      if (turn && !set.rankedBy) {
        this.judgeParsed(service, set, turn, rank, risk).catch((error: unknown) =>
          console.warn('[next-steps] JEV ranking of a parsed set failed', error)
        )
      }
    }
  }

  private turnOf(service: NextStepSuggestionService, set: NextStepSuggestionSet) {
    if (!set.conversation) {
      return null
    }
    const key = conversationSourceRowKey(set.conversation)
    const turn = service.currentTurns.get(key)?.turn ?? service.latestTurns.get(key)
    return turn?.turnKey === set.turnKey ? turn : null
  }

  private async judgeParsed(
    service: NextStepSuggestionService,
    set: NextStepSuggestionSet,
    turn: FinishedTurn,
    rank: boolean,
    risk: boolean
  ): Promise<void> {
    const judged = await judgeNextStepSuggestions(
      { turnText: nextStepTurnText(turn), suggestions: set.suggestions, rank, risk },
      this.deps.jev
    )
    // Every field of every step, not only its id: a step rewritten in place is a different step.
    const sameSteps = (current: NextStepSuggestionSet) =>
      JSON.stringify(current.suggestions) === JSON.stringify(set.suggestions)
    const current = service.deps.store.get(set.id)
    // Answered, superseded, changed or switched off meanwhile: JEV's late reading changes nothing.
    if (current?.status !== 'pending' || !sameSteps(current) || !this.stillOn(rank, risk)) {
      return
    }
    service.deps.store.update(set.id, (latest) => ({ ...latest, ...judged }))
  }

  /** `assessNextStepDoneness` behind the doneness switch: what Keep going injects. */
  assessDoneness = (input: NextStepDonenessInput): Promise<NextStepDoneness | null> =>
    this.switches.doneness
      ? assessNextStepDoneness(input, { ...this.deps.jev, cache: this.cache })
      : Promise.resolve(null)

  /** The goal for a conversation: its linked card, else the first prompt seen, else the latest. */
  goalFor(turn: Pick<FinishedTurn, 'conversation' | 'lastUserPrompt'>): Promise<string | null> {
    const key = conversationSourceRowKey(turn.conversation)
    return resolveNextStepGoal({
      taskId: this.taskLinks.get(key),
      readTaskCard: this.deps.readTaskCard,
      firstPrompt: this.firstPrompts.get(key),
      latestPrompt: personPrompt(
        turn.lastUserPrompt ?? this.service?.latestTurns.get(key)?.lastUserPrompt
      )
    })
  }

  /** Keep going's judges, behind the doneness switch; each is null when JEV has no reading. */
  keepGoingJudges(): Required<Omit<NextStepKeepGoingJudges, 'judgeTimeoutMs'>> {
    return {
      assessDoneness: async ({ conversation, turnKey, reply }) => {
        const goal = this.switches.doneness ? await this.goalFor({ conversation }) : null
        const reading = goal
          ? await this.assessDoneness({ conversation, turnKey, goal, replyTail: reply })
          : null
        return this.switches.doneness ? reading : null
      },
      judgeImprovement: async ({ conversation, previous, latest, pushPrompt }) => {
        if (!this.switches.doneness) {
          return null
        }
        // Without a goal there is nothing to judge "better" against: no verdict, not "not better".
        const goal = await this.goalFor({ conversation })
        // Rechecked after the card lookup: switched off meanwhile, nothing is sent.
        if (!goal || !this.switches.doneness) {
          return null
        }
        const verdict = await judgeNextStepImprovement(
          { goal, pushPrompt, previous, latest },
          this.deps.jev
        )
        return this.switches.doneness ? verdict : null
      }
    }
  }

  /** Once per finished turn, off the critical path; failures leave no reading. */
  assessTurn(turn: FinishedTurn, gitFacts?: NextStepGitFacts | NextStepGitFactsUnavailable): void {
    if (!this.switches.doneness || this.cache.get(turn.turnKey)) {
      return
    }
    void this.goalFor(turn)
      .then((goal) =>
        goal
          ? this.assessDoneness({
              conversation: turn.conversation,
              turnKey: turn.turnKey,
              goal,
              replyTail: turn.lastAssistantMessage,
              ...(gitFacts ? { gitFacts } : {})
            })
          : null
      )
      .catch((error: unknown) => console.warn('[next-steps] doneness reading failed', error))
  }

  /** The reading `nextSteps.current` carries for a turn; none while the switch is off. */
  readDoneness = (turnKey: string): NextStepDoneness | undefined =>
    this.switches.doneness ? this.cache.get(turnKey) : undefined
}
