import { createHash } from 'node:crypto'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  type DiscoverCommitMessageModelsResult
} from '../text-generation/commit-message-text-generation'
import type {
  SessionPrepRouterCatalog,
  SessionPrepRouterRequest
} from '../session-prep/session-prep-router-types'
import { WorkflowScriptSlots } from './workflow-script/workflow-script-slots'

const ACCOUNT_MODEL_WAIT_MS = 3_000
const slots = new WorkflowScriptSlots(2)
const pending = new Map<
  string,
  { result: Promise<SessionPrepRouterCatalog>; signal: AbortSignal }
>()

function waitForCatalog(
  result: Promise<SessionPrepRouterCatalog>,
  deadline: AbortSignal,
  caller: AbortSignal | undefined,
  fallback: SessionPrepRouterCatalog
): Promise<SessionPrepRouterCatalog> {
  if (deadline.aborted || caller?.aborted) {
    return Promise.resolve(fallback)
  }
  return new Promise((resolve) => {
    const done = (value: SessionPrepRouterCatalog) => {
      deadline.removeEventListener('abort', abort)
      caller?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = () => done(fallback)
    deadline.addEventListener('abort', abort, { once: true })
    caller?.addEventListener('abort', abort, { once: true })
    void result.then(done, abort)
  })
}

/** Probe the already-verified launch account; only concurrent identical probes share evidence. */
export async function discoverAgentSessionAccountCatalog(
  request: SessionPrepRouterRequest,
  accountEnv: Readonly<Record<string, string>> | undefined,
  commandOverride?: string,
  signal?: AbortSignal
): Promise<SessionPrepRouterCatalog> {
  const target = request.executionTarget
  const provider = request.provider
  const hostId = target?.hostId ?? 'local'
  const unavailable = (error: string): SessionPrepRouterCatalog => ({
    hostId,
    observedAt: Date.now(),
    agents: provider ? [{ provider, models: [], discovered: false, error }] : []
  })
  const homeKey = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  if (
    !provider ||
    !['codex', 'claude'].includes(provider) ||
    !accountEnv?.[homeKey]?.trim() ||
    !target?.path ||
    signal?.aborted
  ) {
    return unavailable('The verified execution account cannot be probed for model routing.')
  }
  const env = target.connectionId ? { ...accountEnv } : { ...process.env, ...accountEnv }
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        provider,
        hostId,
        target.connectionId,
        target.path,
        commandOverride,
        Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
      ])
    )
    .digest('hex')
  let current = pending.get(key)
  if (!current) {
    // The shared probe owns cancellation: one disconnected caller cannot cancel another's listing.
    const controller = new AbortController()
    const expiresAt = Date.now() + ACCOUNT_MODEL_WAIT_MS
    const timeout = setTimeout(() => controller.abort(), ACCOUNT_MODEL_WAIT_MS)
    const probe = async (): Promise<SessionPrepRouterCatalog> => {
      if (Date.now() >= expiresAt) {
        return unavailable('The verified execution account model probe expired while queued.')
      }
      let listing: DiscoverCommitMessageModelsResult
      if (target.connectionId) {
        const remote = requireSshGitProvider(target.connectionId)
        listing = await discoverCommitMessageModelsRemote(
          provider,
          target.path,
          (plan, cwd, timeoutMs) =>
            remote.executeCommitMessagePlan(
              plan,
              cwd,
              Math.min(timeoutMs, ACCOUNT_MODEL_WAIT_MS),
              'model-discovery',
              { ...accountEnv },
              controller.signal
            ),
          commandOverride
          // The remote host-only cache does not include the selected account identity.
        )
      } else {
        // A cancellation signal bypasses the existing cache; the map above coalesces account/env identity.
        listing = await discoverCommitMessageModelsLocal(provider, env, commandOverride, {
          cwd: target.path,
          signal: controller.signal,
          force: true
        })
      }
      return listing.success && listing.catalogOrigin === 'probe'
        ? {
            hostId,
            observedAt: Date.now(),
            agents: [{ provider, models: listing.models, discovered: true }]
          }
        : unavailable('The verified execution account did not advertise available models.')
    }
    const result = slots
      .run(probe, controller.signal)
      .catch(() => unavailable('The verified execution account model probe is unavailable.'))
      .finally(() => {
        clearTimeout(timeout)
        pending.delete(key)
      })
    current = { result, signal: controller.signal }
    pending.set(key, current)
  }
  return waitForCatalog(
    current.result,
    current.signal,
    signal,
    unavailable('The verified execution account model probe did not complete before launch.')
  )
}
