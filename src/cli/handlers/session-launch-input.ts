import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session-host-authority'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../shared/agent-session-option-catalog'
import { automationEffortOptions } from '../../shared/automation-launch-preferences'
import type { CapacityProvider } from '../../shared/provider-account-capacity'
import type { OrganizationTitleOrigin } from '../../shared/session-organization-change'
import {
  orchestrationAcceptanceLines,
  renderOrchestrationTaskTemplate
} from '../../shared/orchestration-task-templates'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { readLaunchPlacementFlags } from '../launch-placement-refusals'
import { RuntimeClientError } from '../runtime-client'
import { effortRefusal, providerRefusal } from '../session-launch-refusals'
import { readTextInputFile } from '../text-input-file'
import { titleOriginFlag } from './title-origin-flag'

// Same cap the host enforces (MAX_PROMPT_BYTES in rpc/methods/agent-session.ts).
export const MAX_LAUNCH_BRIEF_BYTES = 256 * 1024
const BRIEF_REFUSAL = 'The launch brief must be non-empty and at most 256 KiB.'

export type LaunchInput = {
  provider: CapacityProvider
  prompt: string
  model?: string
  effort?: string
  title?: string
  titleOrigin?: OrganizationTitleOrigin
  folderRef?: string
  agentArgs?: string
  managedToolsFile?: string
  ephemeral?: boolean
  again: boolean
  dryRun: boolean
  operationId?: string
  controllerRuntimeId?: string
  /** --project: placement picks the computer and creates a fresh worktree there. */
  project?: string
  /** --name for that worktree; otherwise derived from the title or brief. */
  worktreeName?: string
  /** --contract: the brief was rendered from it, and its Acceptance lines get a verify step. */
  contract?: LaunchContract
}

export type LaunchContract = { title: string; acceptance: string[] }

const CONTRACT_HELP = 'See: omni orchestration task-templates --template implement'
const MAX_CONTRACT_LINES = 32

/** The `implement` template's fields as the brief, so a launch carries the same contract a Task does. */
async function readLaunchContract(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<{ brief: string; contract: LaunchContract }> {
  const file = flags.get('contract')
  if (typeof file !== 'string' || file === '') {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --contract')
  }
  if (flags.has('prompt') || flags.has('prompt-file')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass --contract or a brief (--prompt, --prompt-file), not both: the contract is the brief.'
    )
  }
  const text = await readTextInputFile(file, cwd, {
    label: 'contract',
    maxBytes: MAX_LAUNCH_BRIEF_BYTES,
    tooLargeMessage: BRIEF_REFUSAL
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--contract must hold one JSON object. ${CONTRACT_HELP}`
    )
  }
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    // A non-string field renders as missing, so the template names it instead of dropping it.
    values[key] = typeof value === 'string' ? value : ''
  }
  const rendered = renderOrchestrationTaskTemplate('implement', values, { report: 'reply' })
  if (!rendered.ok) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The contract is incomplete; nothing was launched.\n${rendered.problems
        .map((problem) => `- ${problem.field}: ${problem.detail}`)
        .join('\n')}\n${CONTRACT_HELP}`
    )
  }
  const acceptance = orchestrationAcceptanceLines(values.acceptance ?? '')
  // The same bounds the host checks, here, so no line is ever asked for and then left unchecked.
  if (acceptance.length > MAX_CONTRACT_LINES || acceptance.some((line) => line.length > 1_000)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Acceptance takes at most ${MAX_CONTRACT_LINES} checks of at most 1000 characters each; nothing was launched.`
    )
  }
  return {
    brief: rendered.spec,
    contract: {
      title: (values.objective ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      acceptance
    }
  }
}

async function readLaunchBrief(flags: Map<string, string | boolean>, cwd: string): Promise<string> {
  const inline = flags.get('prompt')
  const file = flags.get('prompt-file')
  if ((inline === undefined) === (file === undefined)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass the brief exactly once: --prompt-file <path|-> or --prompt "<text>".'
    )
  }
  if (inline === true || file === true || file === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Missing value for --${inline ? 'prompt' : 'prompt-file'}`
    )
  }
  const prompt =
    typeof inline === 'string'
      ? inline
      : await readTextInputFile(String(file), cwd, {
          label: 'brief',
          maxBytes: MAX_LAUNCH_BRIEF_BYTES,
          tooLargeMessage: BRIEF_REFUSAL
        })
  if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_LAUNCH_BRIEF_BYTES) {
    throw new RuntimeClientError('invalid_argument', BRIEF_REFUSAL)
  }
  return prompt
}

// Why: only a catalog-known model has a known effort list; a newer model is sent unvalidated.
function assertLaunchEffort(provider: CapacityProvider, model?: string, effort?: string): void {
  const catalog = getAgentSessionOptionCatalog(provider)
  if (!effort || !model || !catalog || !findCatalogModel(catalog, model)) {
    return
  }
  const choices = automationEffortOptions(provider, model).map((choice) => choice.value)
  if (choices.length > 0 && !choices.includes(effort)) {
    throw effortRefusal({ effort, provider, model, choices })
  }
}

/** Everything the invocation asked for; refuses bad input before any host contact. */
export async function readLaunchInput(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<LaunchInput> {
  const provider = getRequiredStringFlag(flags, 'provider')
  if (provider !== 'claude' && provider !== 'codex') {
    throw providerRefusal()
  }
  const placement = readLaunchPlacementFlags(flags)
  const operationId = getOptionalStringFlag(flags, 'operation-id')
  if (
    flags.has('operation-id') &&
    (operationId === undefined || parseAgentSessionOperationTimestamp(operationId) === null)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use a timestamped native launch operation ID and keep it for retries, or omit --operation-id.'
    )
  }
  if (typeof flags.get('again') === 'string') {
    throw new RuntimeClientError('invalid_argument', '--again takes no value.')
  }
  if (typeof flags.get('ephemeral') === 'string') {
    throw new RuntimeClientError('invalid_argument', '--ephemeral takes no value.')
  }
  const model = getOptionalStringFlag(flags, 'model')
  const effort = getOptionalStringFlag(flags, 'effort')
  assertLaunchEffort(provider, model, effort)
  const contracted = flags.has('contract') ? await readLaunchContract(flags, cwd) : null
  if (
    flags.has('managed-tools-file') &&
    (!operationId || flags.has('project') || flags.has('agent-args'))
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Managed tools require an explicit operation ID and host defaults on a fixed workspace.'
    )
  }
  return {
    provider,
    prompt: contracted?.brief ?? (await readLaunchBrief(flags, cwd)),
    ...(contracted ? { contract: contracted.contract } : {}),
    model,
    effort,
    title: getOptionalStringFlag(flags, 'title'),
    titleOrigin: titleOriginFlag(flags, 'title-origin'),
    folderRef: getOptionalStringFlag(flags, 'folder'),
    agentArgs: getOptionalStringFlag(flags, 'agent-args'),
    managedToolsFile: getOptionalStringFlag(flags, 'managed-tools-file'),
    ...(flags.get('ephemeral') === true ? { ephemeral: true } : {}),
    again: flags.get('again') === true,
    dryRun: flags.get('dry-run') === true,
    operationId,
    controllerRuntimeId: getOptionalStringFlag(flags, 'controller-runtime-id'),
    ...placement
  }
}
