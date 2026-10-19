import { MANAGED_SESSION_INSPECT_METHOD } from './managed-session-inspect'
import { rpcTerminalLaunchCause } from '../terminal-launch-cause'
import { AgentTemplateIdParam } from './agent-templates'
import { openrouterCandidates } from '../../../../shared/openrouter-route'
import { z } from 'zod'
import {
  getAgentResumeArgv,
  hasUnsafeProviderSessionIdChars,
  RESUMABLE_TUI_AGENTS
} from '../../../../shared/agent-session-resume'
import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../../shared/agent-session-host-authority'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { defineMethod, type RpcAnyMethod } from '../core'
import { admitCreateAgentSession, WorkContractParam } from './agent-session-work-admission'

const MAX_WORKTREE_SELECTOR_LENGTH = 32_768
const MAX_TRANSCRIPT_PATH_BYTES = 16 * 1024
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_AGENT_ARGS_BYTES = 16 * 1024
const MAX_LAUNCH_PREFERENCE_LENGTH = 512

export const StrictNonEmptyString = (max: number, message: string) =>
  z
    .string()
    .min(1, message)
    .max(max, message)
    .refine((value) => value === value.trim(), `${message}; surrounding whitespace is invalid`)

export const WorktreeSelector = StrictNonEmptyString(
  MAX_WORKTREE_SELECTOR_LENGTH,
  'Invalid worktree selector'
)

const Presentation = z.enum(['background', 'focused'])

const Placement = z
  .object({
    tabId: z
      .string()
      .min(1)
      .max(512)
      .refine(isValidTerminalTabId, 'Invalid terminal tab ID')
      .optional(),
    leafId: z.string().min(1).max(128).optional()
  })
  .strict()
  .refine((value) => value.tabId !== undefined || value.leafId !== undefined, {
    message: 'Placement must include a tab or leaf ID'
  })

const LaunchPreferences = z
  .object({
    model: StrictNonEmptyString(
      MAX_LAUNCH_PREFERENCE_LENGTH,
      'Invalid model preference'
    ).optional(),
    codexAccountId: z.string().trim().min(1).max(120).optional(),
    effort: StrictNonEmptyString(
      MAX_LAUNCH_PREFERENCE_LENGTH,
      'Invalid effort preference'
    ).optional(),
    openrouterCandidates: openrouterCandidates.optional(),
    mode: StrictNonEmptyString(MAX_LAUNCH_PREFERENCE_LENGTH, 'Invalid mode preference').optional()
  })
  .strict()

const PromptDelivery = z.enum(['auto-submit', 'draft'])

const AgentArgs = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_AGENT_ARGS_BYTES,
    'Agent arguments are too large'
  )
  .nullable()

const OmpResumeFilePath = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Invalid OMP resume path')
  .refine(
    (value) =>
      !hasUnsafeProviderSessionIdChars(value) &&
      Buffer.byteLength(value, 'utf8') <= MAX_TRANSCRIPT_PATH_BYTES,
    'Invalid OMP resume path'
  )

const ProviderSession = z
  .object({
    key: z.enum(['session_id', 'conversation_id']),
    id: StrictNonEmptyString(512, 'Invalid provider session ID').refine(
      (value) => !value.startsWith('-') && !hasUnsafeProviderSessionIdChars(value),
      'Invalid provider session ID'
    ),
    transcriptPath: z
      .string()
      .min(1)
      .refine((value) => value === value.trim(), 'Invalid transcript path')
      .refine(
        (value) =>
          !hasUnsafeProviderSessionIdChars(value) &&
          Buffer.byteLength(value, 'utf8') <= MAX_TRANSCRIPT_PATH_BYTES,
        'Invalid transcript path'
      )
      .optional(),
    verifiedFallback: z
      .object({
        key: z.enum(['session_id', 'conversation_id']),
        id: StrictNonEmptyString(512, 'Invalid provider session ID').refine(
          (value) => !value.startsWith('-') && !hasUnsafeProviderSessionIdChars(value)
        ),
        transcriptPath: z
          .string()
          .min(1)
          .max(MAX_TRANSCRIPT_PATH_BYTES)
          .refine((value) => !hasUnsafeProviderSessionIdChars(value))
      })
      .optional()
  })
  .strict()

const AutomaticEnsure = z
  .object({
    kind: z.literal('automatic'),
    sleepingCheckpointId: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    presentation: Presentation.optional()
  })
  .strict()

const ExplicitEnsure = z
  .object({
    kind: z.literal('explicit'),
    worktree: WorktreeSelector,
    agent: z.enum(RESUMABLE_TUI_AGENTS),
    providerSession: ProviderSession,
    ompResumeFilePath: OmpResumeFilePath.optional(),
    agentArgs: AgentArgs.optional(),
    launchPreferences: LaunchPreferences.optional(),
    presentation: Presentation.optional(),
    placement: Placement.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ompResumeFilePath !== undefined && value.agent !== 'omp') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ompResumeFilePath'],
        message: 'OMP resume path requires the OMP agent'
      })
    }
    if (getAgentResumeArgv(value.agent, value.providerSession, value.ompResumeFilePath) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerSession'],
        message: 'Provider session is not resumable for this agent'
      })
    }
  })

export const EnsureAgentSessionParams: z.ZodType<RuntimeEnsureAgentSessionRequest> =
  z.discriminatedUnion('kind', [AutomaticEnsure, ExplicitEnsure])

export const CreateAgentSessionParams: z.ZodType<RuntimeCreateAgentSessionRequest> = z
  .object({
    launchCause: z.unknown().optional(),
    clientOperationId: z
      .string()
      .refine(
        (value) => parseAgentSessionOperationTimestamp(value) !== null,
        'Invalid agent operation ID'
      ),
    worktree: WorktreeSelector,
    agent: z.string().refine(isTuiAgent, 'Unknown agent preset'),
    prompt: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES,
        'Prompt is too large'
      )
      .optional(),
    promptDelivery: PromptDelivery.optional(),
    agentArgs: AgentArgs.optional(),
    managedToolsFile: z.string().min(1).max(4096).optional(),
    launchPreferences: LaunchPreferences.optional(),
    sshAccountSelection: z
      .object({
        policy: z.literal('best-verified'),
        expectedHostId: z
          .string()
          .min(5)
          .max(512)
          .regex(/^(local|ssh:[^\s]+)$/),
        expectedRuntimeId: z.string().uuid()
      })
      .strict()
      .optional(),
    startupCwd: z.string().min(1).max(MAX_WORKTREE_SELECTOR_LENGTH).optional(),
    presentation: Presentation.optional(),
    revealInSidebar: z.boolean().optional(),
    placement: Placement.optional(),
    viewMode: z.enum(['terminal', 'chat']).optional(),
    agentTemplateId: AgentTemplateIdParam.optional(),
    workContract: WorkContractParam.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.promptDelivery === 'draft' && !value.prompt?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Draft delivery requires a non-empty prompt'
      })
    }
  })

type AgentSessionRuntime = OrcaRuntimeService & {
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    caller?: RuntimeAgentSessionRpcCaller
  ): Promise<RuntimeEnsureAgentSessionResult>
  createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller?: RuntimeAgentSessionRpcCaller
  ): Promise<RuntimeCreateAgentSessionResult>
}

function callerContext(
  clientId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined,
  signal: AbortSignal | undefined
): RuntimeAgentSessionRpcCaller {
  return {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientKind !== undefined ? { clientKind } : {}),
    ...(signal ? { signal } : {})
  }
}

function withExecutionHostAgentPresentation<T extends { presentation?: 'background' | 'focused' }>(
  params: T,
  clientKind: 'mobile' | 'runtime' | undefined
): T {
  // Why: paired viewers focus their own mirror; the execution host may have no renderer.
  return clientKind && params.presentation === 'focused'
    ? { ...params, presentation: 'background' }
    : params
}

function assertOperationTimestampWithinFutureSkew(clientOperationId: string): void {
  const timestamp = parseAgentSessionOperationTimestamp(clientOperationId)
  if (timestamp === null || timestamp > Date.now() + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS) {
    // Why: a future-dated ID could look new again after its idempotency tombstone is collected.
    throw new Error('agent_session_operation_invalid')
  }
}

export const AGENT_SESSION_METHODS: RpcAnyMethod[] = [
  MANAGED_SESSION_INSPECT_METHOD,
  defineMethod({
    name: 'terminal.ensureAgentSession',
    params: EnsureAgentSessionParams,
    handler: (params, context) =>
      (context.runtime as AgentSessionRuntime).ensureAgentSession(
        withExecutionHostAgentPresentation(params, context.clientKind),
        {
          launchCause: rpcTerminalLaunchCause(context, 'agent-session-resume'),
          ...callerContext(
            context.pairedDeviceId ?? context.clientId,
            context.clientKind,
            context.signal
          )
        }
      )
  }),
  defineMethod({
    name: 'terminal.createAgentSession',
    params: CreateAgentSessionParams,
    handler: async (params, context) => {
      assertOperationTimestampWithinFutureSkew(params.clientOperationId)
      const launchCause = rpcTerminalLaunchCause(
        context,
        'agent-session-create',
        params.clientOperationId,
        params.launchCause
      )
      // Why raw params: the viewer-local focused->background rewrite is not an unattended signal.
      const workAdmission = admitCreateAgentSession(params, launchCause)
      const result = await (context.runtime as AgentSessionRuntime).createAgentSession(
        withExecutionHostAgentPresentation(params, context.clientKind),
        {
          launchCause,
          ...callerContext(
            context.pairedDeviceId ?? context.clientId,
            context.clientKind,
            context.signal
          )
        }
      )
      return { ...result, workAdmission }
    }
  })
]
