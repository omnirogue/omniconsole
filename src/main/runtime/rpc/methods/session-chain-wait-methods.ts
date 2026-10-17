import { createHash } from 'node:crypto'
import { z } from 'zod'
import { resolveRosterName } from '../../../../shared/team-roster-search'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { assertSessionOutcomeRuntime } from '../../session-outcome-host-boundary'
import { readSessionOutcomeHandoffPeople } from '../../session-outcome-handoff'
import { sessionOutcomeSource } from '../../session-outcome-source-authority'
import { SESSION_OUTCOME_WAIT_CHOICES, waitChoiceStated } from '../../session-outcome-wait-choice'
import { askConsoleWait } from '../../../backoffice/console-waits-client'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const Choice = z.enum(SESSION_OUTCOME_WAIT_CHOICES)
const Source = z
  .object({ paneKey: requiredString('Missing pane key'), worktreeId: z.string().min(1).optional() })
  .strict()

/**
 * Conversational waits from the owner's side: answering a wait that came back as something other
 * than a yes (the UI, or an agent quoting the owner's own words), and posting an ask to a staff
 * member when the owner's words name the channel. omnios posts the ask; this host decides nothing
 * on its behalf (CONTRACT.md §1, Sal's decision 5).
 */
export const SESSION_CHAIN_WAIT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'sessionChain.chooseOutcomeWait',
    params: z
      .object({
        id: requiredString('Missing chain id'),
        expectedRevision: z.number().int().positive(),
        outcomeId: requiredString('Missing outcome id'),
        conditionId: requiredString('Missing condition id'),
        choice: Choice,
        expectedExecutionRuntimeId: z.string().min(1).optional()
      })
      .strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      assertSessionOutcomeUser(context)
      const { expectedExecutionRuntimeId: _runtime, ...choice } = params
      return { chain: await context.runtime.getSessionOutcomeService().waitChoice(choice) }
    }
  }),
  defineMethod({
    name: 'sessionChain.sourceWaitChoice',
    params: Source.extend({ choice: Choice, conditionId: z.string().min(1).optional() }).strict(),
    handler: async (params, context) => {
      const source = await sessionOutcomeSource(context, params)
      if (!waitChoiceStated(params.choice, source.prompt)) {
        throw new Error(
          `The person's latest message does not say "${params.choice.replace('-', ' ')}". Ask them; never choose for them.`
        )
      }
      const set = source.chain.outcomeSet
      const open = (set?.attention ?? []).filter(
        (request) =>
          request.state === 'open' &&
          request.recipient.type === 'owner' &&
          request.scope.conditionId &&
          (!params.conditionId || request.scope.conditionId === params.conditionId) &&
          set?.outcomes
            .find((outcome) => outcome.id === request.scope.outcomeId)
            ?.conditions.some(
              (condition) =>
                condition.id === request.scope.conditionId &&
                (condition.kind === 'event' || condition.require)
            )
      )
      if (!set || open.length !== 1) {
        throw new Error(
          open.length
            ? 'More than one wait is asking; pass --condition with the one the person meant.'
            : 'No wait in this conversation is asking for a decision.'
        )
      }
      return {
        chain: await context.runtime.getSessionOutcomeService().waitChoice({
          id: source.chain.id,
          expectedRevision: set.revision,
          outcomeId: open[0]!.scope.outcomeId,
          conditionId: open[0]!.scope.conditionId!,
          choice: params.choice
        })
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.waitAsk',
    params: Source.extend({
      person: requiredString('Missing person').pipe(z.string().max(200)),
      via: z.enum(['slack', 'email']),
      text: requiredString('Missing ask text').pipe(z.string().max(2_000))
    }).strict(),
    handler: async (params, context) => {
      const source = await sessionOutcomeSource(context, params)
      // Staff only, and only through the channel the person's own words name.
      const named = params.via === 'slack' ? /\bslack\b/i : /\be-?mail\b|@/i
      if (!named.test(source.prompt)) {
        throw new Error(
          `The person's message does not name ${params.via === 'slack' ? 'Slack' : 'email'}; ask them before posting there.`
        )
      }
      const { people } = await readSessionOutcomeHandoffPeople()
      const match = /^emp_[A-Za-z0-9_-]{1,120}$/.test(params.person)
        ? people.find((person) => person.id === params.person)
        : (() => {
            const result = resolveRosterName(params.person, people)
            return result.kind === 'match' ? result.person : undefined
          })()
      if (!match) {
        throw new Error(`${params.person} is not one person on the staff roster.`)
      }
      const firstName = match.name.split(/\s+/)[0]!
      if (
        !new RegExp(`\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
          source.prompt
        )
      ) {
        throw new Error(`The person's message does not name ${match.name}.`)
      }
      // One ask per conversation, person, channel and message: a retry posts nothing twice.
      const operationId = `wa_${createHash('sha256')
        .update(JSON.stringify([params.paneKey, source.prompt, match.id, params.via]))
        .digest('hex')
        .slice(0, 40)}`
      return askConsoleWait({
        operation_id: operationId,
        source: params.via,
        person_id: match.id,
        text: params.text,
        origin: { session_ref: params.paneKey.slice(0, 256), chain_id: source.chain.id }
      })
    }
  })
]
