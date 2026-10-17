/**
 * `runWakeClaims` on this desktop: OmniOS through the audited request helper, relocate's provider
 * version, account choice and import, the runtime's own workspace creation and resume launch, and
 * the prompt queue for the decision. Claims in progress are kept in the profile folder.
 */

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { sessionRelocationEnabled } from '../session-manage/session-transfer-relocation-switch'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { localProviderVersion } from '../session-manage/session-transfer-provider-version'
import { importRelocationBundle } from '../session-relocation/relocation-bundle-import'
import {
  WAKE_COPY_MAX_BYTES,
  unpackWakeCopy,
  type WakeCopyWorkspace
} from './review-wake-copy-pack'
import { chooseLocalLaunchHome } from '../runtime/local-launch-account-home'
import { deliverMovedDecision, launchMovedConversation } from './review-wake-claimer-launch'
import {
  ARTIFACT_SLUG_PATTERN,
  artifactLifecycleSnapshot,
  type ArtifactReviewStatus
} from '../../shared/artifact-review'
import type { WakeCopyApi } from './review-wake-copy-api'
import { reviewHost } from './review-wake-copy-pass'
import {
  findClaimerWorkspace,
  prepareClaimerBranch,
  restoreWrittenFiles
} from './review-wake-claimer-workspace'
import {
  ClaimerStepError,
  type ClaimRecord,
  type WakeCandidate,
  type WakeClaimerDeps
} from './review-wake-claimer'

const MAX_PARTS = 16
const UNSUPPORTED_BACKOFF_MS = 30 * 60_000
const STATUS_TRIES = 3

/** A launch here that would run in WSL drops the chosen account's pin, so the move refuses it. */
function refuseWslLaunch(
  runtime: Pick<OrcaRuntimeService, 'agentLaunchRunsInWsl'>,
  id: string | null,
  path: string
): void {
  if (id && runtime.agentLaunchRunsInWsl({ id, path, connectionId: null })) {
    throw new ClaimerStepError(
      'launches in this workspace run in WSL here',
      'cannot run here',
      true
    )
  }
}

/** Field by field: OmniOS stores the listing's copy as JSONB, which reorders keys. */
function sameWorkspace(a: WakeCopyWorkspace, b: WakeCopyWorkspace): boolean {
  if (a.kind === 'folder' || b.kind === 'folder') {
    return a.kind === 'folder' && b.kind === 'folder' && a.workRelativePath === b.workRelativePath
  }
  return a.remoteUrl === b.remoteUrl && a.branch === b.branch && a.commit === b.commit
}

export function runtimeWakeClaimerDeps(input: {
  runtime: OrcaRuntimeService
  api: WakeCopyApi
  apiOrigin(): string | null
  userDataPath: string
  reviewStatus(slug: string): Promise<ArtifactReviewStatus | null>
}): WakeClaimerDeps {
  const { runtime, api, userDataPath } = input
  const claimsPath = join(userDataPath, 'review-wake-claims.json')
  const stagingFor = (item: Pick<WakeCandidate, 'slug' | 'revision'>) =>
    join(userDataPath, 'review-wake-copies', `${item.slug}-${item.revision}`)
  const route = (item: Pick<WakeCandidate, 'slug'>, rest: string) =>
    `/${encodeURIComponent(item.slug)}${rest}`
  const readClaims = (): Record<string, ClaimRecord> => {
    try {
      const parsed = JSON.parse(readFileSync(claimsPath, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, ClaimRecord>) : {}
    } catch {
      return {}
    }
  }
  let unsupportedUntil = 0
  return {
    // Why a backoff: every desktop asks each minute, and today's OmniOS has no such route.
    candidates: async () => {
      if (Date.now() < unsupportedUntil) {
        return { status: 'unsupported' }
      }
      const read = await api<{ items?: WakeCandidate[] }>('/wake-candidates')
      if (read.status === 'unsupported') {
        unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      }
      return read
    },
    enabled: sessionRelocationEnabled,
    host: reviewHost,
    windowAttached: () => runtime.getStatus().desktopWindowStatus === 'available',
    providerVersion: localProviderVersion,
    // Why the launch chooser: it refreshes stale readings first (an unfocused, headless host),
    // applies the Fable rule and the selected default, and never falls back to an unverified account.
    providerHome: (provider) =>
      chooseLocalLaunchHome(runtime.getLaunchAccountCapacity(), provider, undefined),
    chooseAccount: (provider, model) =>
      chooseLocalLaunchHome(runtime.getLaunchAccountCapacity(), provider, model),
    // Why on the page's current revision only: a newer one has its own decision to wait for.
    latestDecision: async (item) => {
      for (let attempt = 0; attempt < STATUS_TRIES; attempt += 1) {
        const status = await input.reviewStatus(item.slug).catch(() => null)
        if (status) {
          const latest = status.latest
          const lifecycle = artifactLifecycleSnapshot(status)
          return lifecycle.lifecycle === null &&
            lifecycle.supersededBy === null &&
            (status.artifact.revision ?? item.revision) === item.revision &&
            latest &&
            latest.revision === item.revision &&
            latest.decision !== 'rejected'
            ? latest
            : 'closed'
        }
        await new Promise((done) => setTimeout(done, 5_000))
      }
      return null
    },
    findWorkspace: (required) =>
      findClaimerWorkspace(required, {
        repos: runtime.listRepos(),
        folders: runtime.listFolderWorkspaces(),
        groups: runtime.listProjectGroups()
      }),
    claim: (item, host) =>
      api(route(item, '/wake-claim'), {
        method: 'POST',
        body: { decisionId: String(item.decision.id), revision: item.revision, ...host }
      }),
    // Why a refusal counts as released: OmniOS holds no claim of ours (gone, or never won).
    release: async (slug, host, reason) => {
      const sent = await api(route({ slug }, '/wake-claim/release'), {
        method: 'POST',
        body: { hostId: host.hostId, reason }
      })
      return sent.status === 'ok' || sent.status === 'refused'
    },
    done: (slug, host) =>
      api(route({ slug }, '/wake-claim/done'), { method: 'POST', body: { hostId: host.hostId } }),
    fetchCopy: async (item, host) => {
      if (
        !ARTIFACT_SLUG_PATTERN.test(item.slug) ||
        item.copy.parts > MAX_PARTS ||
        item.copy.bytes > WAKE_COPY_MAX_BYTES
      ) {
        throw new ClaimerStepError('the wake copy is not one OmniOS keeps', 'could not verify')
      }
      const parts: Buffer[] = []
      for (let part = 0; part < item.copy.parts; part += 1) {
        const read = await api<Buffer>(
          route(item, `/wake-copy/parts/${part}?hostId=${encodeURIComponent(host.hostId)}`),
          { binary: true, timeoutMs: 120_000 }
        )
        if (read.status !== 'ok') {
          throw new ClaimerStepError('the wake copy could not be downloaded', 'download failed')
        }
        parts.push(read.value)
      }
      const staging = stagingFor(item)
      await rm(staging, { recursive: true, force: true })
      const copy = await unpackWakeCopy(Buffer.concat(parts), item.copy.sha256, staging).catch(
        (error: unknown) => {
          throw new ClaimerStepError(String(error), 'could not verify')
        }
      )
      const { header } = copy
      if (
        header.slug !== item.slug ||
        header.revision !== item.revision ||
        header.provider !== item.requirements.provider ||
        !sameWorkspace(header.workspace, item.requirements.workspace)
      ) {
        throw new ClaimerStepError('the wake copy is not the one OmniOS listed', 'could not verify')
      }
      return copy
    },
    prepareWorkspace: async (workspace) => {
      if (workspace.kind === 'folder') {
        // Why before creating: a folder workspace nobody asked for would otherwise stay behind.
        refuseWslLaunch(runtime, workspace.workspaceId ?? 'folder-to-create', workspace.path)
        const id =
          workspace.workspaceId ??
          (workspace.projectGroupId
            ? (
                await runtime.createFolderWorkspace({
                  projectGroupId: workspace.projectGroupId,
                  folderPath: workspace.path,
                  name: basename(workspace.path)
                })
              ).id
            : null)
        refuseWslLaunch(runtime, id, workspace.path)
        return workspace.path
      }
      await prepareClaimerBranch(workspace)
      // Why baseBranch: the create checks out an existing branch only when it is the base.
      const created = await runtime.createManagedWorktree({
        repoSelector: `id:${workspace.repo.id}`,
        name: workspace.branch.split('/').at(-1) ?? workspace.branch,
        branchNameOverride: workspace.branch,
        baseBranch: workspace.branch,
        activate: false,
        runHooks: false,
        setupDecision: 'skip'
      })
      const branch = created.worktree.branch?.replace(/^refs\/heads\//, '')
      if (branch !== workspace.branch || created.worktree.head !== workspace.commit) {
        await runtime
          .removeManagedWorktree(`id:${created.worktree.id}`, true, false)
          .catch(() => {})
        throw new Error(`the new worktree is not on ${workspace.branch} at the commit it slept on`)
      }
      try {
        refuseWslLaunch(runtime, created.worktree.id, created.worktree.path)
      } catch (error) {
        // Its branch would stay checked out there and block every later wake of it.
        await runtime
          .removeManagedWorktree(`id:${created.worktree.id}`, true, false)
          .catch(() => {})
        throw error
      }
      return created.worktree.path
    },
    restoreWritten: restoreWrittenFiles,
    stage: ({ header, bundleRoot, providerRoot, workspacePath, providerVersion }) =>
      importRelocationBundle({
        stagingRoot: bundleRoot,
        manifest: header.manifest,
        place: { providerRoot, workspacePath },
        providerVersion
      }),
    launch: (staged, workspacePath, header) =>
      launchMovedConversation(runtime, userDataPath, staged, workspacePath, header),
    deliver: (paneKey, item, sessionId, moved) =>
      deliverMovedDecision(runtime, input.apiOrigin(), paneKey, item, sessionId, moved),
    accountLabel: (provider, providerRoot) =>
      (runtime.getAccountsSnapshot().rateLimits.accountCapacity?.[provider] ?? []).find((row) =>
        Object.values(row.launchEnv ?? {}).some((home) => resolve(home) === resolve(providerRoot))
      )?.email ?? null,
    readClaims,
    writeClaim: (slug, record) => {
      const claims = readClaims()
      if (record) {
        claims[slug] = record
      } else {
        delete claims[slug]
      }
      writeDurableSecureJsonFile(claimsPath, claims)
    },
    cleanup: async (slug, revision) => {
      if (ARTIFACT_SLUG_PATTERN.test(slug)) {
        await rm(stagingFor({ slug, revision }), { recursive: true, force: true })
      }
    },
    audit: (item, summary) => {
      void sessionActionsLogFor(userDataPath)
        .append({
          actor: 'artifact-review',
          action: 'resume',
          target: { paneKey: null },
          summary,
          artifactReview: { slug: item.slug, revision: item.revision }
        })
        .catch(() => {})
    },
    now: () => Date.now()
  }
}
