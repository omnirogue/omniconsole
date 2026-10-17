import type {
  AgentLaunchHostId,
  AgentLaunchReadinessResult
} from '../../shared/agent-launch-account'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { parseExecutionHostId, type ParsedExecutionHost } from '../../shared/execution-host'
import {
  emptyLaunchManifest,
  launchManifestReport,
  type LaunchManifestReport
} from '../../shared/launch-manifest'
import {
  AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_MANAGED_TOOLS_RUNTIME_CAPABILITY,
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { HandlerContext } from '../dispatch'
import { resolveHostFlagTarget } from '../execution-host-flag'
import { getOptionalStringFlag } from '../flags'
import { listSshTargets } from '../host-selector-alternatives'
import { launchFlagsAsTyped } from '../launch-host-name'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import type {
  AgentLaunchHostReceipt,
  AgentLaunchRoute,
  AgentLaunchWorkspaceReceipt
} from '../session-launch-record'
import {
  composedPromptTooLargeRefusal,
  effortOnlyRefusal,
  hostMismatchRefusal,
  incompatibleRuntimeRefusal,
  restartedWhilePlanningRefusal,
  staleControllerRuntimeRefusal
} from '../session-launch-refusals'
import { agentTemplateLaunchFlag } from './agent-template-flag'
import { resolveFolderForNewTerminal } from './session-folders'
import { MAX_LAUNCH_BRIEF_BYTES, type LaunchInput } from './session-launch-input'
import { projectBriefForLaunch, type ProjectBrief } from './session-launch-project'
import {
  launchHostReceipt,
  launchRouteName,
  readLaunchReadiness,
  readLaunchStatus,
  resolveLaunchRoute,
  resolveLaunchWorkspace,
  type LaunchHostStatus
} from './session-launch-target'

export type LaunchPlan = {
  route: AgentLaunchRoute
  status: LaunchHostStatus
  /** Explicit `ssh:` against a runtime without verified launches: today's payload, unchanged. */
  legacy: boolean
  host: AgentLaunchHostReceipt
  workspace: AgentLaunchWorkspaceReceipt
  readiness: AgentLaunchReadinessResult | null
  request: Omit<RuntimeCreateAgentSessionRequest, 'clientOperationId'>
  folderId: string | null
  project: ProjectBrief | null
  manifest: LaunchManifestReport
}

// Why: without the capability only an explicit ssh: gets this far, and that is its host.
function legacySshHostId(requested: ParsedExecutionHost | undefined): AgentLaunchHostId {
  if (requested?.kind !== 'ssh') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Name the SSH host with --host ssh:<target-id>.'
    )
  }
  return requested.id
}

// Why: the routed runtime knows its own SSH targets' labels; a raw id alone is hard to act on.
async function describeHost(
  hostId: string,
  route: AgentLaunchRoute,
  client: RuntimeClient
): Promise<string> {
  const workspace = parseExecutionHostId(hostId)
  if (workspace?.kind !== 'ssh') {
    return hostId === 'local' ? launchRouteName(route) : hostId
  }
  const target = (await listSshTargets(client)).find((entry) => entry.id === workspace.targetId)
  return target ? `${target.label} (${hostId})` : hostId
}

/** R6: a named computer is an assertion about where the workspace lives. */
async function assertRequestedHost(
  requested: ParsedExecutionHost | undefined,
  hostId: AgentLaunchHostId,
  context: { selector: string; route: AgentLaunchRoute; typed: string; client: RuntimeClient }
): Promise<void> {
  if (!requested) {
    return
  }
  const workspace = parseExecutionHostId(hostId)
  const matches =
    requested.kind === 'ssh'
      ? workspace?.kind === 'ssh' && workspace.targetId === requested.targetId
      : hostId === 'local'
  if (!matches) {
    const { route } = context
    throw hostMismatchRefusal({
      selector: context.selector,
      workspaceHost: await describeHost(hostId, route, context.client),
      requestedHost: context.typed,
      ...(requested.kind === 'runtime' && route.kind === 'environment'
        ? { pairedName: route.name }
        : {})
    })
  }
}

/**
 * Reads only: status, the capability gate (R1, R16), the workspace and its host (R6, R12), then
 * the folder and project brief, and builds the exact request a launch sends.
 */
export async function planSessionLaunch(
  ctx: Pick<HandlerContext, 'flags' | 'client' | 'cwd'>,
  input: LaunchInput,
  options: { preview: boolean; expectedRuntimeId?: string }
): Promise<LaunchPlan> {
  const { flags, client, cwd } = ctx
  const route = resolveLaunchRoute(flags, client)
  // Why: on a paired route this needs no RPC, so a cwd shortcut refuses before contacting it.
  const remoteTarget = client.isRemote
    ? await resolveLaunchWorkspace(flags, cwd, client, route)
    : null
  const status = await readLaunchStatus(client, route)
  if (options.expectedRuntimeId && options.expectedRuntimeId !== status.runtimeId) {
    throw staleControllerRuntimeRefusal({
      hostName: launchRouteName(route),
      given: options.expectedRuntimeId,
      running: status.runtimeId
    })
  }
  if (
    input.managedToolsFile &&
    !status.capabilities.includes(AGENT_SESSION_MANAGED_TOOLS_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This execution host cannot attach managed session tools. Nothing launched.'
    )
  }
  const requested = await resolveHostFlagTarget(flags, client)
  const verified = status.capabilities.includes(
    AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
  )
  if (!verified && requested?.kind !== 'ssh') {
    throw incompatibleRuntimeRefusal({
      name: launchRouteName(route),
      local: route.kind === 'local',
      appVersion: status.appVersion
    })
  }
  if (
    input.effort &&
    !input.model &&
    !status.capabilities.includes(AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY)
  ) {
    throw effortOnlyRefusal(launchRouteName(route))
  }
  const target = remoteTarget ?? (await resolveLaunchWorkspace(flags, cwd, client, route))
  const readiness = verified
    ? await readLaunchReadiness(
        client,
        {
          worktree: target.selector,
          agent: input.provider,
          ...(input.model ? { model: input.model } : {}),
          preview: options.preview
        },
        { route, cwd, derivedFromCwd: target.derivedFromCwd }
      )
    : null
  if (readiness && readiness.runtimeId !== status.runtimeId) {
    throw restartedWhilePlanningRefusal(launchRouteName(route))
  }
  const hostId = readiness?.workspace.hostId ?? legacySshHostId(requested)
  await assertRequestedHost(requested, hostId, {
    selector: target.selector,
    route,
    typed: getOptionalStringFlag(launchFlagsAsTyped(flags), 'host') ?? '',
    client
  })
  const agentTemplateId = await agentTemplateLaunchFlag(flags, client)
  const folderId = input.folderRef
    ? await resolveFolderForNewTerminal(client, input.folderRef)
    : null
  const project = folderId
    ? await projectBriefForLaunch(client, {
        folderId,
        host: hostId,
        worktree: target.selector,
        prompt: input.prompt,
        folderName: input.folderRef,
        ...(agentTemplateId ? { templateId: agentTemplateId } : {})
      })
    : null
  const prompt = project?.prompt ?? input.prompt
  // Why: the host refuses a larger prompt before spawning, but its invalid_argument counts as
  // unverifiable here and every retry would resend it; refusing first sends nothing and says so.
  const promptBytes = Buffer.byteLength(prompt, 'utf8')
  if (promptBytes > MAX_LAUNCH_BRIEF_BYTES) {
    throw composedPromptTooLargeRefusal(promptBytes, MAX_LAUNCH_BRIEF_BYTES)
  }
  const manifest = launchManifestReport({
    ...(project?.manifest ??
      (folderId && input.folderRef
        ? { ...emptyLaunchManifest(input.prompt), folder: { id: folderId, name: input.folderRef } }
        : emptyLaunchManifest(input.prompt))),
    ...(input.agentArgs !== undefined ? { agentArgs: input.agentArgs } : {})
  })
  const launchPreferences =
    input.model || input.effort
      ? {
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {})
        }
      : undefined
  return {
    route,
    status,
    legacy: !verified,
    host: await launchHostReceipt({ flags, client, route, status, hostId }),
    workspace: {
      selector: target.selector,
      ...(readiness ? { id: readiness.workspace.id, kind: readiness.workspace.kind } : {}),
      hostId
    },
    readiness,
    request: {
      worktree: target.selector,
      agent: input.provider,
      prompt,
      promptDelivery: 'auto-submit',
      // Why: the host swaps its default provider flags for these, so a caller must send
      // the complete set; a role's system-prompt appendix or settings overlay rides here.
      ...(input.agentArgs !== undefined ? { agentArgs: input.agentArgs } : {}),
      ...(input.managedToolsFile ? { managedToolsFile: input.managedToolsFile } : {}),
      ...(agentTemplateId ? { agentTemplateId } : {}),
      presentation: 'background',
      ...(client.isRemote ? {} : { revealInSidebar: true }),
      viewMode: 'terminal',
      // Why: omitted, the host resolves its own defaults with the chosen account's home.
      ...(launchPreferences ? { launchPreferences } : {}),
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: hostId,
        expectedRuntimeId: status.runtimeId
      }
    },
    folderId,
    project,
    manifest
  }
}
