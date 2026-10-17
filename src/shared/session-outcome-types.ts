import { openrouterCandidates, validOpenRouterRoute } from './openrouter-route'
import { sessionFinishChoiceSchema } from './session-finish-intent'
import { outcomeAmendmentIntentSchema } from './outcome-amendment-cancellation'
import {
  sessionOutcomeSourceBindingSchema,
  sessionOutcomeSourcePacketSchema
} from './session-outcome-source-packet'
import { sessionOutcomeConversationTurnSchema } from './session-outcome-conversation-turn'
import { z } from 'zod'
import { sessionOutcomeTaskRefSchema } from './session-outcome-task-ref'
export type { SessionOutcomeTaskRef } from './session-outcome-task-ref'
export { sessionOutcomeTaskRefSchema } from './session-outcome-task-ref'
import {
  sessionOutcomePublicationSchema,
  sessionOutcomeWorkflowSchema
} from './session-outcome-workflow'
import { isTuiAgent } from './tui-agent-config'
// Why at the top: the CLI's CommonJS emit reads a bottom import before it is assigned (TDZ).
import { sessionOutcomeInitialSource } from './session-outcome-initial-source'
import type { TuiAgent } from './tui-agent'
import { humanAttentionRequestSchema } from './session-human-attention'
import { sessionOutcomeBlockSchema } from './session-outcome-block'
import {
  sessionAttemptAwaitingSchema,
  sessionAttemptFailureSchema
} from './session-attempt-recovery'
import { sessionRunCompletionSchema, sessionRunDispositionSchema } from './session-run-completion'
import { sessionRunHeldContinuationSchema } from './session-run-held-continuation'
import { sessionOutcomeEventSchema, sessionOutcomeWaitFactSchema } from './session-outcome-event'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const text = z.string().trim().min(1).max(32_000)
/** One line a person reads, not a target a machine resolves. */
const label = z.string().trim().min(1).max(200)
/**
 * Which version of the plan a record belongs to. Absent means 1 — everything written before a plan
 * could be superseded. A chain is the lineage of one pursuit, so v1's steps, attempts and receipts
 * stay addressable beside v2's; the version is what tells them apart.
 */
const planVersion = z.number().int().positive()
export const sessionOutcomeConditionSchema = z
  .object({
    id,
    kind: z.enum([
      'file',
      'review',
      'handoff',
      'pr',
      'merge',
      'deployment',
      'command',
      'report',
      'session',
      'event'
    ]),
    /** Changing the Done-when requirement advances the outcome revision and requires fresh proof. */
    label: label.optional(),
    target: text,
    version: text.optional(),
    repository: text.optional(),
    branch: text.optional(),
    targetBranch: text.optional(),
    recipientId: text.optional(),
    recipientSessionId: id.optional(),
    /** A named person's review counts only as an approval; "needs changes" goes to the owner. */
    require: z.literal('approve').optional(),
    event: sessionOutcomeEventSchema.optional(),
    fileVersions: z
      .array(
        z
          .object({
            path: text,
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            /**
             * The file must parse and match this schema for the condition to be met. WP-6 owns the
             * evaluator; the pin is carried here so a plan whose deliverable is a document, and whose
             * bytes cannot be known when it is committed, can still be verified by something.
             */
            schema: z.literal('work-plan-v1').optional()
          })
          .strict()
          // Why: a pin with neither a version nor a schema proves nothing about the delivered file.
          .refine(
            (file) => Boolean(file.sha256 ?? file.schema),
            'Pin the file version, the expected schema, or both.'
          )
      )
      .optional(),
    verification: z
      .object({
        program: text,
        args: z.array(z.string()).max(128),
        expectedStdout: text.optional()
      })
      .strict()
      .optional()
  })
  .strict()
export const sessionOutcomeActionSchema = z
  .object({
    id,
    instruction: z.string().trim().min(1).max(128_000),
    conditionIds: z.array(id).min(1),
    authority: z.literal('existing-user-authority'),
    agent: z.custom<TuiAgent>(isTuiAgent),
    model: text.optional(),
    openrouterCandidates: openrouterCandidates.optional(),
    effort: text.optional(),
    accountChoiceId: text.nullable().optional(),
    /** Continue the conversation that filed the plan instead of starting a worker (a chat wait). */
    route: z.literal('same-session').optional()
  })
  .strict()
  .refine(validOpenRouterRoute, 'OpenRouter candidates require OMP and the selected model first.')
export const sessionOutcomeDefinitionSchema = z
  .object({
    id,
    title: text,
    finish: z.enum(['complete', 'my-review', 'human-handoff', 'pr', 'merge', 'deploy']),
    instructions: text.optional(),
    /**
     * What the outcome produces: ordinary work, a plan document, or a mockup. Absent means `work`,
     * which every outcome committed before Plan Mode is.
     */
    outputKind: z.enum(['work', 'plan', 'mockup']).optional(),
    dependsOn: z.array(id),
    stepIds: z.array(id).optional(),
    conditions: z.array(sessionOutcomeConditionSchema).min(1),
    actions: z.array(sessionOutcomeActionSchema)
  })
  .strict()
export type SessionOutcomeDefinition = z.infer<typeof sessionOutcomeDefinitionSchema>
export type SessionOutcomeCondition = z.infer<typeof sessionOutcomeConditionSchema>
export type SessionOutcomeAction = z.infer<typeof sessionOutcomeActionSchema>
export const sessionOutcomeEvidenceSchema = z
  .object({
    id,
    outcomeId: id,
    conditionId: id,
    outcomeRevision: z.number().int().positive(),
    conditionKey: text,
    kind: sessionOutcomeConditionSchema.shape.kind,
    target: text,
    version: text.optional(),
    receipt: text,
    verifiedAt: z.number().finite().nonnegative(),
    verifier: z.literal('execution-host'),
    /** Half of `producedUnder`: the other half is `outcomeRevision`, already above. */
    planVersion: planVersion.optional()
  })
  .strict()
export type SessionOutcomeEvidence = z.infer<typeof sessionOutcomeEvidenceSchema>
export const sessionOutcomeAttemptSchema = z
  .object({
    id,
    outcomeId: id,
    actionId: id,
    actionKey: z.string().min(1).max(256_000),
    outcomeRevision: z.number().int().positive(),
    state: z.enum([
      'prepared',
      'launching',
      'running',
      'completed',
      'unverifiable',
      'blocked',
      'retryable',
      /**
       * A newer plan version replaced the work this attempt was for. Terminal and quiet: it is not
       * a failure, it never blocks the outcome, and the attempt is kept so what ran stays readable.
       */
      'superseded'
    ]),
    planVersion: planVersion.optional(),
    continuationTaskId: text.optional(),
    nativeContinuation: z
      .object({
        previousDispatchId: text,
        worktreeId: text,
        briefSha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .optional(),
    /**
     * This attempt is a turn of the ORIGINAL conversation rather than a worker of its own: the
     * producer's conversation handle and its delivery receipt (`session-outcome-conversation-turn`).
     */
    conversationTurn: sessionOutcomeConversationTurnSchema.optional(),
    launchDisposition: z.enum(['not-started', 'started', 'unverifiable']).optional(),
    taskId: text.optional(),
    dispatchId: text.optional(),
    runId: text.optional(),
    coordinatorHandle: text.optional(),
    /** Stable pane identity used to adopt this hidden coordinator after a host restart. */
    coordinatorPaneKey: text.optional(),
    resultMessageId: text.optional(),
    error: text.optional(),
    /** Why it stopped, as a code the recovery ladder reads; `error` stays the diagnostic prose. */
    failure: sessionAttemptFailureSchema.optional(),
    /** The agent is alive and asking its person something: a request, never a failure. */
    awaiting: sessionAttemptAwaitingSchema.optional(),
    startedAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative()
  })
  .strict()
export type SessionOutcomeAttempt = z.infer<typeof sessionOutcomeAttemptSchema>
export const sessionOutcomeSchema = sessionOutcomeDefinitionSchema
  .extend({
    revision: z.number().int().positive(),
    status: z.enum(['pending', 'running', 'blocked', 'satisfied']),
    evidence: z.array(sessionOutcomeEvidenceSchema),
    blockedReason: text.optional(),
    /** Why it is blocked, by class; the reason above is only ever a diagnostic. */
    block: sessionOutcomeBlockSchema.optional(),
    /**
     * Runtime, never definition: `sessionOutcomeDefinition()` leaves it out on purpose, so filing an
     * outcome under a card bumps no revision, spends no receipt and changes no status.
     */
    taskRef: sessionOutcomeTaskRefSchema.optional(),
    /** Runtime, never definition: the last reading of each `event` condition. */
    waits: z.array(sessionOutcomeWaitFactSchema).max(64).optional()
  })
  .strict()
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>
export const sessionOutcomeSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionFinish: sessionFinishChoiceSchema.optional(),
    workflow: sessionOutcomeWorkflowSchema.optional(),
    planDefinitionSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    amendment: outcomeAmendmentIntentSchema.optional(),
    publications: z.array(sessionOutcomePublicationSchema).optional(),
    workflowHistory: z.array(sessionOutcomeWorkflowSchema).max(32).optional(),
    revision: z.number().int().positive(),
    outcomes: z.array(sessionOutcomeSchema).min(1),
    removals: z.array(
      z
        .object({
          outcomeId: id,
          revision: z.number().int().positive(),
          reason: text,
          removedAt: z.number().finite()
        })
        .strict()
    ),
    attempts: z.array(sessionOutcomeAttemptSchema),
    completedSteps: z.array(id).optional(),
    evidenceHistory: z.array(sessionOutcomeEvidenceSchema).optional(),
    /** The only source of "needs you" (`session-human-attention.ts`). */
    attention: z.array(humanAttentionRequestSchema).max(128).optional(),
    /** The seal: once set, this run is complete and stays complete (`session-run-completion.ts`). */
    completion: sessionRunCompletionSchema.optional(),
    disposition: sessionRunDispositionSchema.optional(),
    /** Work queued behind this run's own review, still to run: the run is not over. */
    heldContinuation: sessionRunHeldContinuationSchema.optional(),
    continuation: z
      .object({
        owner: z.literal('execution-host'),
        hostId: text,
        epoch: id,
        principal: text.optional(),
        taskId: text.optional(),
        planningSource: z
          .object({
            runId: text,
            projectionTaskId: text,
            coordinatorHandle: text,
            processIncarnation: text
          })
          .strict()
          .optional(),
        nativeSource: z
          .object({
            runId: text,
            projectionTaskId: text,
            sourceDispatchId: text
          })
          .strict()
          .optional(),
        sourceReady: z.boolean().optional(),
        sourceVersion: text.optional(),
        sourceBinding: sessionOutcomeSourceBindingSchema.optional(),
        sourcePacket: sessionOutcomeSourcePacketSchema.optional(),
        initialSource: sessionOutcomeInitialSource.optional(),
        state: z.enum(['owned', 'unverifiable'])
      })
      .strict(),
    updatedAt: z.number().finite().nonnegative()
  })
  .strict()
export type SessionOutcomeSet = z.infer<typeof sessionOutcomeSetSchema>
export type { SessionOutcomeCommit } from './session-outcome-commit-types'
export type SessionOutcomeLifecycle = 'waiting' | 'needs-you' | 'complete'

export { sessionOutcomeConditionKey, sessionOutcomeActionKey } from './session-outcome-keys'
export function sessionOutcomeDefinition(
  outcome: SessionOutcomeDefinition
): SessionOutcomeDefinition {
  return {
    id: outcome.id,
    title: outcome.title,
    finish: outcome.finish,
    ...(outcome.instructions ? { instructions: outcome.instructions } : {}),
    // Why: this mapper is what `reviseSessionOutcomeSet` compares to decide an outcome CHANGED.
    // A field missing here reads as unchanged: no revision bump, retained evidence, kept status.
    ...(outcome.outputKind ? { outputKind: outcome.outputKind } : {}),
    dependsOn: outcome.dependsOn,
    ...(outcome.stepIds ? { stepIds: outcome.stepIds } : {}),
    conditions: outcome.conditions,
    actions: outcome.actions
  }
}
