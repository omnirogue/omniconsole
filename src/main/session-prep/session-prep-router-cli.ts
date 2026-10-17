import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import { SESSION_PREP_EFFORTS, type SessionPrepEffort } from '../../shared/session-prep-types'
import { selectRouterCandidate } from './session-prep-router-candidates'
import type {
  SessionPrepRouterDecision,
  SessionPrepRouterRequest,
  SessionPrepRouterResult,
  SessionPrepRoutingMode
} from './session-prep-router-types'
export type {
  SessionPrepRouterCatalog,
  SessionPrepRouterDecision,
  SessionPrepRouterRequest,
  SessionPrepRouterResult,
  SessionPrepRoutingMode
} from './session-prep-router-types'

const ROUTER_TIMEOUT_MS = 6000
const ROUTER_MAX_OUTPUT_BYTES = 256 * 1024

/** Operator configuration wins over an intake; omitted preserves existing live dispatch. */
export function sessionPrepRoutingMode(mode?: SessionPrepRoutingMode): SessionPrepRoutingMode {
  const operator = process.env.OMNI_DISPATCH_ROUTER_MODE
  if (operator === 'off' || operator === 'shadow' || operator === 'live') {
    return operator
  }
  return mode ?? 'live'
}

export function routerScriptLocation(): {
  path: string
  origin: 'override' | 'estate' | 'bundled'
} {
  if (process.env.OMNI_ROUTE_SCRIPT) {
    return { path: process.env.OMNI_ROUTE_SCRIPT, origin: 'override' }
  }
  const estate = join(homedir(), 'Work', 'Ops', 'autonomy', 'bin', 'omni_route.py')
  if (existsSync(estate)) {
    return { path: estate, origin: 'estate' }
  }
  const app = getAppEnvironment()
  const root = app.isPackaged() ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return { path: join(root, 'dispatch-router', 'omni_route.py'), origin: 'bundled' }
}

/** One bounded classification, no worker launches, retries or fallback model invocations here. */
export async function runSessionPrepRouter(
  request: SessionPrepRouterRequest
): Promise<SessionPrepRouterResult> {
  const started = Date.now()
  const mode = sessionPrepRoutingMode(request.mode)
  const requested = { provider: request.provider, model: request.model, effort: request.effort }
  if (mode === 'off') {
    return { status: 'off', unrouted: 'Routing disabled', mode, requested, elapsedMs: 0 }
  }
  let origin: 'override' | 'estate' | 'bundled' | undefined
  let version: string | undefined
  try {
    const script = routerScriptLocation()
    origin = script.origin
    if (process.platform === 'win32' || !existsSync(script.path)) {
      return {
        status: 'unavailable',
        unrouted: 'Dispatch classifier or Python host unavailable',
        mode,
        origin,
        requested,
        elapsedMs: Date.now() - started
      }
    }
    version = `catalog-v1:${createHash('sha256').update(readFileSync(script.path)).digest('hex').slice(0, 16)}`
    // Process argv is visible to host observers; request text travels only over stdin.
    const opaqueTitle = `dispatch-${createHash('sha256')
      .update(JSON.stringify([request.title, request.brief]))
      .digest('hex')
      .slice(0, 16)}`
    const args = [script.path, 'route', '--prompt-file', '-', '--title', opaqueTitle, '--json']
    // Other agents reuse the same complexity classifier, then the catalog adapter selects them.
    const estateProvider = request.provider === 'claude' || request.provider === 'codex'
    for (const [flag, value] of [
      ['--provider', estateProvider ? request.provider : undefined],
      ['--model', estateProvider || !request.provider ? request.model : undefined],
      ['--effort', request.effort]
    ] as const) {
      if (value) {
        args.push(flag, value)
      }
    }
    const result = await runProcess({
      program: 'python3',
      args,
      input: request.brief,
      timeoutMs: ROUTER_TIMEOUT_MS,
      maxOutputBytes: ROUTER_MAX_OUTPUT_BYTES
    })
    const metadata = { mode, origin, version, requested, elapsedMs: Date.now() - started }
    // Do not persist CLI stderr: it may contain request text or account details.
    if (result.timedOut || result.code !== 0 || result.stdoutTruncated) {
      return {
        status: 'unavailable',
        unrouted: result.timedOut
          ? 'Dispatch classification timed out'
          : 'Dispatch classifier failed',
        ...metadata
      }
    }
    const decision = parseRouterDecision(result.stdout)
    if (!decision) {
      return { status: 'unavailable', unrouted: 'Unreadable dispatch decision', ...metadata }
    }
    return { ...selectRouterCandidate(request, decision), ...metadata }
  } catch {
    return {
      status: 'unavailable',
      unrouted: 'Dispatch classifier could not be started',
      mode,
      origin,
      version,
      requested,
      elapsedMs: Date.now() - started
    }
  }
}

export function parseRouterDecision(stdout: string): SessionPrepRouterDecision | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const value = raw as Record<string, unknown>
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '')
  const provider = text('provider')
  const effort = text('effort') as SessionPrepEffort
  const model = text('model').trim()
  if (
    (provider !== 'claude' && provider !== 'codex') ||
    !SESSION_PREP_EFFORTS.includes(effort) ||
    !model ||
    model.length > 100
  ) {
    return null
  }
  return {
    provider,
    model,
    effort,
    tier: text('tier'),
    gate: text('gate'),
    reason: text('reason'),
    note: text('note')
  }
}
