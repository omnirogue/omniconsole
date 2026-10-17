import { attachOutcome, commitUserOutcome } from './outcome-edit'
import { auditOutcomes } from './outcome-audit'
import { outcomeWaitHandlers } from './outcome-wait'
import { sessionFinishChoiceSchema } from '../../shared/session-finish-intent'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { createOrchestrationCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'
import { sessionOutcomeDefinitionSchema } from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  nextOutcomeIntentSubmissionSchema,
  validateNextOutcomeIntentSubmission
} from '../../shared/next-outcome-intent-definition'
import { NEXT_OUTCOME_AGENT_INSTRUCTIONS } from '../../shared/next-outcome-intent-instructions'
import { compileNextOutcomeTeamPlan } from '../../shared/next-outcome-team-plan-compile'
import {
  NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS,
  nextOutcomeTeamPlanConsent
} from '../../shared/next-outcome-team-plan-instructions'
import {
  NEXT_OUTCOME_TEAM_LIMITS,
  nextOutcomeTeamPlanSchema,
  nextOutcomeTeamUsableModels,
  type NextOutcomeTeamUsableAgent
} from '../../shared/next-outcome-team-plan-schema'
import { isTuiAgent } from '../../shared/tui-agent-config'

type OutcomeSource = { chain: SessionChain; prompt: string; expectedRevision: number }

async function readSource(client: HandlerContext['client'], flags: HandlerContext['flags']) {
  const paneKey = process.env.ORCA_PANE_KEY?.trim()
  if (!paneKey) {
    throw new RuntimeClientError(
      'invalid_environment',
      'Run outcome commands inside the current OmniConsole source conversation.'
    )
  }
  const envelope = createOrchestrationCompatibilityEnvelope(process.env)
  const capability = flags.get('dispatch-capability')
  const options = {
    ...envelope,
    ...(typeof capability === 'string' ? { orchestrationCapability: capability } : {})
  }
  const capabilities = await client.call<{
    executionRuntimeId?: string
    sessionFinish?: 1
    version: number
    durableContinuation: boolean
    teamPlans?: number
    inferredReviewPlans?: number
    eventWaits?: number
    sessionWaits?: number
    reason?: string
  }>('sessionChain.outcomeCapabilities')
  if (capabilities.result.version !== 1 || !capabilities.result.durableContinuation) {
    throw new RuntimeClientError(
      'unsupported_capability',
      capabilities.result.reason ?? 'This execution host cannot durably bind outcomes.'
    )
  }
  const response = await client.call<OutcomeSource>(
    'sessionChain.outcomeSource',
    {
      paneKey,
      ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {})
    },
    options
  )
  return {
    response,
    options,
    capabilities: capabilities.result,
    teamPlans: capabilities.result.teamPlans === 1
  }
}

/** The same host probes the Start Work picker trusts: installed agents and their exact launchable models. */
async function readTeamUsableAgents(
  client: HandlerContext['client'],
  chain: SessionChain
): Promise<NextOutcomeTeamUsableAgent[]> {
  const detected: unknown[] = await client
    .call<unknown[]>('preflight.detectAgents')
    .then((response) => response.result)
    .catch(() => [])
  const installed = detected.filter(isTuiAgent)
  const agents = await Promise.all(
    installed.map(async (agent) => ({
      agent,
      models: nextOutcomeTeamUsableModels(
        agent,
        await client
          .call<Parameters<typeof nextOutcomeTeamUsableModels>[1]>(
            'git.discoverCommitMessageModels',
            { worktree: `id:${chain.sourceWorktreeId ?? chain.worktreeId}`, agentId: agent }
          )
          .then((response) => response.result)
          .catch(() => null)
      )
    }))
  )
  return agents.filter((entry) => entry.models.length > 0)
}

export const OUTCOME_HANDLERS: Record<string, CommandHandler> = {
  ...outcomeWaitHandlers,
  'outcome attach': attachOutcome,
  'outcome audit': auditOutcomes,
  'outcome context': async ({ client, flags, json }) => {
    const { response, capabilities, teamPlans } = await readSource(client, flags)
    const consent = nextOutcomeTeamPlanConsent(response.result.prompt)
    const teamPlanning =
      consent && teamPlans
        ? {
            consentedAt: consent.consentedAt,
            limits: NEXT_OUTCOME_TEAM_LIMITS,
            usableAgents: await readTeamUsableAgents(client, response.result.chain),
            teamSchema: z.toJSONSchema(nextOutcomeTeamPlanSchema, { unrepresentable: 'any' })
          }
        : null
    printResult(
      {
        ...response,
        result: {
          ...response.result,
          sessionFinishSupported: capabilities.sessionFinish === 1,
          eventWaitsSupported: capabilities.eventWaits === 1,
          sessionFinishSchema: z.toJSONSchema(sessionFinishChoiceSchema),
          inferredReviewPlansSupported: capabilities.inferredReviewPlans === 1,
          definitionSchema: z.toJSONSchema(sessionOutcomeDefinitionSchema, {
            unrepresentable: 'any'
          }),
          submissionSchema: z.toJSONSchema(nextOutcomeIntentSubmissionSchema, {
            unrepresentable: 'any'
          }),
          instructions: teamPlanning
            ? NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS
            : NEXT_OUTCOME_AGENT_INSTRUCTIONS,
          ...(teamPlanning ? { teamPlanning } : {})
        }
      },
      json,
      (result) => JSON.stringify(result, null, 2)
    )
  },
  'outcome commit': async (context) => {
    const { client, flags, cwd, json } = context
    const file = flags.get('body-file')
    if (typeof file !== 'string' || !file.trim()) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Provide --body-file <path|-> with the inferred outcome JSON.'
      )
    }
    if (file !== '-' && process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use --body-file - through the remote CLI bridge; the source file belongs to its execution host.'
      )
    }
    if (file === '-' && process.stdin.isTTY) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pipe outcome JSON to stdin when using --body-file -.'
      )
    }
    const raw = readFileSync(file === '-' ? 0 : resolve(cwd, file), 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > 1_048_576) {
      throw new RuntimeClientError('invalid_argument', 'Outcome definition exceeds 1 MiB.')
    }
    if (flags.has('task') || flags.has('supersede')) {
      return commitUserOutcome(context, raw)
    }
    const { response, options, capabilities, teamPlans } = await readSource(client, flags)
    const source = response.result
    const submission = validateNextOutcomeIntentSubmission(JSON.parse(raw), {
      prompt: source.prompt,
      expectedRevision: source.expectedRevision,
      outcomes: source.chain.outcomeSet?.outcomes ?? []
    })
    if (submission.team) {
      if (!teamPlans) {
        throw new RuntimeClientError(
          'unsupported_capability',
          'This execution host cannot commit an agent-planned team. Update OmniConsole there, or commit the outcome without a team.'
        )
      }
      // Structural refusal here saves a round trip; the host re-checks limits against its live models.
      compileNextOutcomeTeamPlan({
        team: submission.team,
        outcomes: submission.outcomes,
        chainId: source.chain.id,
        workspacePath: source.chain.workspacePath,
        sessionLabel: source.chain.id
      })
    }
    if (
      (submission.sessionFinish ||
        submission.outcomes.some((outcome) =>
          outcome.conditions.some((condition) => condition.kind === 'session')
        )) &&
      capabilities.sessionFinish !== 1
    ) {
      throw new RuntimeClientError(
        'unsupported_capability',
        'Update the execution host to save a session finish choice from chat.'
      )
    }
    if (
      submission.outcomes.some(
        (outcome) =>
          outcome.conditions.some((condition) => condition.kind === 'event' || condition.require) ||
          outcome.actions.some((action) => action.route)
      ) &&
      capabilities.eventWaits !== 1
    ) {
      throw new RuntimeClientError(
        'unsupported_capability',
        'Update the execution host to file waits ("wait for …, then …") from chat.'
      )
    }
    if (
      submission.outcomes.some((outcome) =>
        outcome.conditions.some((condition) => condition.event?.source === 'session')
      ) &&
      capabilities.sessionWaits !== 1
    ) {
      throw new RuntimeClientError(
        'unsupported_capability',
        "This execution host cannot wait on another session's result. Update OmniConsole there."
      )
    }
    if (submission.reviewPlans?.length && capabilities.inferredReviewPlans !== 1) {
      throw new RuntimeClientError(
        'unsupported_capability',
        'Update this execution host before filing review settings from chat.'
      )
    }
    const result = await client.call<{ chain: SessionChain }>(
      'sessionChain.commitOutcomes',
      {
        chain: source.chain,
        ...(capabilities.executionRuntimeId
          ? { expectedExecutionRuntimeId: capabilities.executionRuntimeId }
          : {}),
        expectedRevision: submission.expectedRevision,
        expectedSourcePrompt: submission.sourcePrompt,
        outcomes: submission.outcomes,
        ...(submission.team ? { team: submission.team } : {}),
        ...(submission.sessionFinish ? { sessionFinish: submission.sessionFinish } : {}),
        ...(submission.reviewPlans ? { reviewPlans: submission.reviewPlans } : {}),
        source: 'ai'
      },
      options
    )
    printResult(
      result,
      json,
      () => 'Outcome set saved. Completion remains conditional on host-verified evidence.'
    )
  }
}
