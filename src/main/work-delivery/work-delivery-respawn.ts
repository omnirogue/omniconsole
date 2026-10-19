/**
 * The one fresh session a delivery may start when its conversation is gone: launched through
 * `createAgentSession` on a verified account with room, the same way a session transfer launches.
 */

import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { parseSessionReference, type SessionReferenceAgent } from '../../shared/session-reference'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { WorkDeliveryHold, messageOf, type WorkPane } from './work-delivery-claimer-types'
import { workDeliveryEstatePaths, type WorkDeliveryEstatePaths } from './work-delivery-estate-paths'
import type { ClaimableDelivery, WorkDeliveryTarget } from './work-delivery-kind'

type RespawnRuntime = Pick<
  OrcaRuntimeService,
  | 'agentLaunchReadiness'
  | 'createAgentSession'
  | 'getTerminalPaneKey'
  | 'getReportedProviderSessionsForPane'
>

/** The host that runs the workspace, which chooses the fresh start's account. */
export type FreshStartAccount = { hostId: string; runtimeId: string }

export function freshStartRequest(input: {
  operationId: string
  folder: string
  agent: SessionReferenceAgent
  brief: string
  target: WorkDeliveryTarget
  account: FreshStartAccount
}): RuntimeCreateAgentSessionRequest {
  const { target, account } = input
  return {
    clientOperationId: input.operationId,
    worktree: `path:${input.folder}`,
    agent: input.agent,
    prompt: input.brief,
    promptDelivery: 'auto-submit',
    presentation: 'background',
    revealInSidebar: true,
    viewMode: 'terminal',
    // Why: a fresh start uses a verified account with room, or waits; never an unverified fallback.
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: account.hostId,
      expectedRuntimeId: account.runtimeId
    },
    ...(target.model || target.effort
      ? {
          launchPreferences: {
            ...(target.model ? { model: target.model } : {}),
            ...(target.effort ? { effort: target.effort } : {})
          }
        }
      : {})
  }
}

const inside = (parent: string, path: string): boolean => {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Where a replacement may start, nearest first: the recorded folder; for a worktree
 * (`<parent>/<repo>-worktrees/...`) its repository's main checkout; then each enclosing folder up
 * to the Work root. Folders outside the Work root are never offered except the recorded one.
 */
export function candidateRespawnFolders(
  folder: string,
  paths: Pick<WorkDeliveryEstatePaths, 'workRoot' | 'prototypesDir'>
): string[] {
  const candidates = [folder]
  const add = (candidate: string) => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }
  let worktreeRepo: string | null = null
  for (let current = folder; dirname(current) !== current; current = dirname(current)) {
    const name = basename(current)
    if (name.endsWith('-worktrees') && name.length > '-worktrees'.length) {
      worktreeRepo = name.slice(0, -'-worktrees'.length)
      break
    }
  }
  if (worktreeRepo) {
    add(join(paths.prototypesDir, worktreeRepo))
  }
  if (inside(paths.workRoot, folder)) {
    for (
      let current = dirname(folder);
      inside(paths.workRoot, current);
      current = dirname(current)
    ) {
      add(current)
      if (current === dirname(current)) {
        break
      }
    }
  }
  if (worktreeRepo) {
    add(paths.workRoot)
  }
  return candidates
}

export type RespawnFolderOptions = {
  paths?: Pick<WorkDeliveryEstatePaths, 'workRoot' | 'prototypesDir'>
  /** True when the folder is on disk; a folder that exists is never swapped for another. */
  exists?: (folder: string) => Promise<boolean>
}

const folderOnDisk = async (folder: string): Promise<boolean> =>
  (await stat(folder).catch(() => null))?.isDirectory() ?? false

export async function respawnFreshSession(
  runtime: RespawnRuntime,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget,
  brief: string,
  operationId: string,
  options: RespawnFolderOptions = {}
): Promise<
  WorkPane & { title: string; ref: string; conversationId: string | null; folder: string }
> {
  const agent = parseSessionReference(target.ref)?.agent ?? 'claude'
  if (!target.folder) {
    throw new WorkDeliveryHold(
      'not_found',
      'Its folder is not recorded, so a fresh session has nowhere to start.'
    )
  }
  const readinessIn = (folder: string) =>
    runtime.agentLaunchReadiness({ worktree: `path:${folder}`, agent, preview: false })
  let folder = target.folder
  let readiness: Awaited<ReturnType<typeof readinessIn>> | null = null
  let firstError: unknown = null
  try {
    readiness = await readinessIn(folder)
  } catch (error) {
    firstError = error
  }
  // Why only when it is gone: a folder that exists but refuses is held, never replaced.
  if (!readiness && !(await (options.exists ?? folderOnDisk)(target.folder))) {
    const paths = options.paths ?? workDeliveryEstatePaths()
    for (const candidate of candidateRespawnFolders(target.folder, paths).slice(1)) {
      readiness = await readinessIn(candidate).catch(() => null)
      if (readiness) {
        folder = candidate
        break
      }
    }
  }
  if (!readiness) {
    throw new WorkDeliveryHold('not_found', `Its folder cannot be opened: ${messageOf(firstError)}`)
  }
  const prompt =
    folder === target.folder
      ? brief
      : `Its original folder ${target.folder} no longer exists, so you start in ${folder}.\n\n${brief}`
  const request = freshStartRequest({
    operationId,
    folder,
    agent,
    brief: prompt,
    target,
    account: { hostId: readiness.workspace.hostId, runtimeId: readiness.runtimeId }
  })
  const created = await runtime
    .createAgentSession(request, {
      launchCause: { trigger: 'agent-session-create', requestId: operationId }
    })
    .catch((error: unknown) => {
      throw respawnRefusal(error)
    })
  const paneKey = created.terminal.paneKey ?? runtime.getTerminalPaneKey(created.terminal.handle)
  if (!paneKey) {
    throw new Error(
      `A fresh session for ${delivery.workItem} started, but its pane cannot be named.`
    )
  }
  return {
    paneKey,
    worktreeId: created.terminal.worktreeId,
    tabId: created.terminal.tabId ?? null,
    archived: false,
    title: created.terminal.title ?? delivery.workItem,
    ref: `pane:${paneKey}`,
    folder,
    conversationId: runtime.getReportedProviderSessionsForPane(paneKey)[0]?.id ?? null
  }
}

/** A refusal before the spawn started nothing and is retried; an unknown outcome is passed on. */
export function respawnRefusal(error: unknown): unknown {
  const fields = (error ?? {}) as { agentSessionOperationOutcome?: unknown; code?: unknown }
  if (fields.agentSessionOperationOutcome === 'unknown') {
    return error
  }
  const reason = fields.code === 'agent_session_account_unverified' ? 'account_at_limit' : 'error'
  return new WorkDeliveryHold(reason, messageOf(error))
}
