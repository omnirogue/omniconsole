/**
 * The steps a handoff or consolidation adds when its new target runs on another computer: plan the
 * host and workspace (reads only), make sure each source's work is on its remote, start the target
 * there with the brief and branch as its first prompt, and check the same target before archiving.
 * A copied prompt is not relocation: the source conversation stays here, archived only after the
 * target's exact acceptance. Unreachable is `unverifiable`, never moved.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionTransferHost } from '../../shared/session-transfer-types'
import { refuseHardStop, SessionManageRefusal } from './session-manage-refusal'
import type { TransferSession } from './session-manage-transfer-contract'
import type {
  HostMovePlan,
  SessionTransferHostDeps,
  SessionTransferHostRequest,
  TransferSourceWork
} from './session-transfer-host-contract'

export const HOST_MOVE_PAIRED_RUNTIME_REFUSAL =
  'Moving work to a paired OmniConsole (runtime:<id>) is not supported yet: this computer cannot verify a session there accepted the work. Use an SSH host from omni host list. Nothing was changed.'

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing was changed.`)
}

/** Validates the request and reads the host, workspace and every source's work; changes nothing. */
export async function planHostMove(
  host: SessionTransferHostDeps | undefined,
  request: SessionTransferHostRequest,
  target: TransferSession | 'new',
  sources: TransferSession[]
): Promise<HostMovePlan> {
  const parsed = parseExecutionHostId(request.hostId)
  if (parsed?.kind === 'runtime') {
    throw new SessionManageRefusal(HOST_MOVE_PAIRED_RUNTIME_REFUSAL)
  }
  if (parsed?.kind !== 'ssh') {
    refuse(`--host takes an SSH host from omni host list (ssh:<id>), not ${request.hostId}.`)
  }
  if (target !== 'new') {
    refuse('--host starts a new session on that computer, so the target must be new.')
  }
  if (!host) {
    refuse('This computer cannot start sessions on another computer.')
  }
  const agent = sources[0].entry.agent
  if (agent !== 'claude' && agent !== 'codex') {
    refuse(
      `A move starts Claude or Codex on the other computer; “${sources[0].entry.title}” runs ${agent}.`
    )
  }
  return host.plan(sources, request)
}

/** A detached or unreadable HEAD has no branch another computer could fetch. */
export function refuseSourcesOffBranch(
  sources: readonly TransferSession[],
  works: readonly TransferSourceWork[]
): void {
  works.forEach((work, index) => {
    if (work.kind === 'git' && !work.branch) {
      refuse(
        `“${sources[index].entry.title}” is not on a branch (a detached HEAD, or its git state could not be read), so another computer has nothing to fetch.`
      )
    }
  })
}

/** Why this source's work is not yet on its remote, or null when it all is. */
export function unpushedReason(work: TransferSourceWork): string | null {
  if (work.kind === 'folder') {
    return null
  }
  const reasons: string[] = []
  if (work.uncommitted > 0) {
    reasons.push(`${work.uncommitted} uncommitted file${work.uncommitted === 1 ? '' : 's'}`)
  }
  if (work.upstream === 'none') {
    reasons.push(`branch ${work.branch} has never been pushed`)
  } else if (work.upstream === 'unknown') {
    reasons.push(`whether branch ${work.branch} is pushed could not be read`)
  } else if (work.upstream.ahead > 0) {
    reasons.push(
      `${work.upstream.ahead} commit${work.upstream.ahead === 1 ? ' is' : 's are'} not on ${work.upstream.name}`
    )
  }
  return reasons.length ? reasons.join(', ') : null
}

/** Names the branch after `push` so a shared branch trips the ask's hard stop. */
export function pushQuestion(work: Extract<TransferSourceWork, { kind: 'git' }>): string {
  return `This work is moving to another computer, which can continue only from what is on the remote. Commit your finished work, then push branch ${work.branch} to its remote (setting its upstream if it has none). Reply with only the branch name. If you cannot, say why.`
}

/**
 * Asks each source with unpushed work to push its branch, then re-reads git on this computer;
 * the controller itself commits and pushes nothing. Returns every source's work as it stands now.
 */
export async function ensureSourcesPushed(
  host: SessionTransferHostDeps,
  sources: readonly TransferSession[],
  works: readonly TransferSourceWork[],
  ask: (source: TransferSession, question: string) => Promise<string>
): Promise<TransferSourceWork[]> {
  const current: TransferSourceWork[] = []
  for (const [index, source] of sources.entries()) {
    let work = works[index]
    if (work.kind === 'git' && unpushedReason(work)) {
      await ask(source, pushQuestion(work))
      work = await host.readWork(source)
    }
    const reason = unpushedReason(work)
    if (work.kind === 'git' && reason) {
      const remote = typeof work.upstream === 'object' ? work.upstream.name.split('/')[0] : 'origin'
      throw new SessionManageRefusal(
        `“${source.entry.title}” still has unpushed work (${reason}). Nothing was moved. Push it (or ask the person to): in ${work.path ?? 'its workspace'}, commit the work and run git push -u ${remote} ${work.branch}; then retry.`
      )
    }
    current.push(work)
  }
  return current
}

/** Re-reads every source right before launch: its work must still be on its remote. */
export async function confirmSourcesPushed(
  host: SessionTransferHostDeps,
  sources: readonly TransferSession[]
): Promise<TransferSourceWork[]> {
  const works = await Promise.all(sources.map((source) => host.readWork(source)))
  works.forEach((work, index) => {
    const reason = unpushedReason(work)
    if (reason) {
      throw new SessionManageRefusal(
        `“${sources[index].entry.title}” changed its work while writing its brief (${reason}), so it was not moved.`
      )
    }
  })
  return works
}

/** Avoids "pushed to <branch>" wording, which would trip the shared-branch hard stop. */
export function hostMovePrompt(
  brief: string,
  plan: HostMovePlan,
  sources: readonly TransferSession[],
  works: readonly TransferSourceWork[]
): string {
  const lines = works.map((work, index) => {
    const title = sources[index].entry.title
    return work.kind === 'git' && typeof work.upstream === 'object'
      ? `“${title}” worked on branch ${work.branch}, which is on ${work.upstream.name} at commit ${work.head ?? 'unknown'}.`
      : `“${title}” worked in the folder ${work.path ?? 'unknown'} on another computer; its files were not copied here.`
  })
  const first = works[0]
  const check =
    first.kind === 'git' && typeof first.upstream === 'object'
      ? `Before you accept: fetch ${first.upstream.name.split('/')[0]} and make sure this workspace is on branch ${first.branch} with commit ${first.head ?? 'its latest commit'} (switch to ${first.branch} if another branch is checked out; fast-forward only). If this workspace has uncommitted changes of its own, or you cannot get that commit, do not accept; say why.`
      : 'Before you accept: make sure this workspace holds the files the brief names. If it does not, do not accept; say why.'
  return `${brief}\n\nWhere it continues: you run on ${plan.label} (${plan.hostId}) in ${plan.workspace.path}.\n${lines.join('\n')}\n${check}`
}

/** The plan and first prompt as the sources' work stands now; the whole prompt passes the hard stops. */
export async function hostLaunchPrompt(
  host: SessionTransferHostDeps,
  plan: HostMovePlan,
  sources: readonly TransferSession[],
  brief: string
): Promise<{ plan: HostMovePlan; prompt: string }> {
  const works = await confirmSourcesPushed(host, sources)
  const current = { ...plan, works }
  const prompt = hostMovePrompt(brief, current, sources, works)
  refuseHardStop(prompt)
  return { plan: current, prompt }
}

/**
 * The acknowledged target must still be the same pane on the planned host and live there. Its
 * sidebar key is not compared: it moves to the provider session once the new agent reports one.
 */
export function assertHostTarget(
  before: TransferSession,
  after: TransferSession,
  plan: HostMovePlan
): void {
  const { entry, row } = after
  const changed = (): never => {
    throw new SessionManageRefusal(
      `The new session on ${plan.label} no longer matches the one that accepted the work; no sources were archived.`
    )
  }
  if (
    entry.paneKey !== before.entry.paneKey ||
    entry.worktreeId !== plan.workspace.id ||
    row.hostId !== plan.hostId
  ) {
    changed()
  }
  if (entry.verdict !== 'live' || entry.archived) {
    throw new SessionManageRefusal(
      `The new session on ${plan.label} is ${entry.archived ? 'archived' : entry.verdict} (${entry.waitingOn ?? 'its host did not confirm it'}), so no sources were archived.`
    )
  }
  if (entry.terminal !== before.entry.terminal || after.source?.paneKey !== before.entry.paneKey) {
    changed()
  }
}

export function hostMoveResult(
  plan: HostMovePlan,
  sources: readonly TransferSession[]
): SessionTransferHost {
  const branches = plan.works.flatMap((work, index) =>
    work.kind === 'git' && work.branch && typeof work.upstream === 'object'
      ? [
          {
            title: sources[index].entry.title,
            branch: work.branch,
            upstream: work.upstream.name,
            head: work.head
          }
        ]
      : []
  )
  return {
    hostId: plan.hostId,
    label: plan.label,
    workspace: { id: plan.workspace.id, path: plan.workspace.path, branch: plan.workspace.branch },
    ...(branches.length ? { branches } : {})
  }
}

/**
 * On a failed move, marks the host `unverifiable` when it cannot be reached now and says so: a
 * launched target there may still be running, and lost contact never proves otherwise.
 */
export function unreachableHostNote(
  host: SessionTransferHostDeps | undefined,
  request: SessionTransferHostRequest | undefined,
  result: { host?: SessionTransferHost; briefSent: boolean }
): string {
  if (!host || !request || parseExecutionHostId(request.hostId)?.kind !== 'ssh') {
    return ''
  }
  if (host.reachable(request.hostId)) {
    return ''
  }
  const label = result.host?.label ?? host.label(request.hostId) ?? request.hostId
  result.host = { ...(result.host ?? { hostId: request.hostId, label }), verdict: 'unverifiable' }
  return ` ${label} cannot be reached now, so the new session's state there is unverifiable${result.briefSent ? '; it may still be running, so inspect it before retrying' : ''}.`
}
