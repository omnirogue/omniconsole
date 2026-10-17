import type { AutomationDispatchResult, AutomationRun } from './automations-types'
import type {
  AutomationRunProviderSession,
  AutomationRunProviderSessionAgent,
  AutomationRunResume
} from './automation-run-resume-types'
import { hasUnsafeProviderSessionIdChars } from './agent-session-resume'

/**
 * The provider thread a routine run actually ran in, and how a later run gets it back.
 *
 * Why this exists: "reuse live session" reuses a PANE. Once the pane is gone (app
 * restart, closed tab, authority change) the routine silently starts a thread with no
 * memory of its earlier runs. Recording the hook-reported thread id on the run lets the
 * next dispatch resume that thread (`codex resume <id>` / `claude --resume <id>`) instead.
 *
 * Pure: shared by the persistence merge (main) and the dispatch decision (renderer).
 */

const RESUMABLE_AUTOMATION_AGENTS: ReadonlySet<string> = new Set(['codex', 'claude'])
const PROVIDER_SESSION_ID_MAX_LENGTH = 512
const RESUME_REASON_MAX_LENGTH = 512

export function isAutomationRunProviderSessionAgent(
  value: unknown
): value is AutomationRunProviderSessionAgent {
  return typeof value === 'string' && RESUMABLE_AUTOMATION_AGENTS.has(value)
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    trimmed.startsWith('-') ||
    hasUnsafeProviderSessionIdChars(trimmed)
  ) {
    return null
  }
  return trimmed
}

function boundedPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 && !hasUnsafeProviderSessionIdChars(trimmed) ? trimmed : null
}

/**
 * The account home that owns a hook-reported transcript, or null when the path does
 * not have the provider's known layout. Codex rollouts live at
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`; Claude transcripts at
 * `<CLAUDE_CONFIG_DIR>/projects/<slug>/<id>.jsonl`.
 */
export function deriveProviderSessionHome(
  agent: AutomationRunProviderSessionAgent,
  transcriptPath: string | null | undefined
): string | null {
  if (!transcriptPath) {
    return null
  }
  const normalized = transcriptPath.replaceAll('\\', '/')
  const marker = agent === 'codex' ? '/sessions/' : '/projects/'
  const index = normalized.lastIndexOf(marker)
  if (index <= 0) {
    return null
  }
  // Why the original slice and not the normalized one: the home is handed back to
  // the platform's own path APIs, so its separators must stay as reported.
  return transcriptPath.slice(0, index)
}

/** Sanitizes a provider-session record that crossed IPC or came off disk. */
export function normalizeAutomationRunProviderSession(
  raw: unknown
): AutomationRunProviderSession | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const providerSessionId = boundedText(record.providerSessionId, PROVIDER_SESSION_ID_MAX_LENGTH)
  const providerSessionAgent = record.providerSessionAgent
  if (!providerSessionId || !isAutomationRunProviderSessionAgent(providerSessionAgent)) {
    return null
  }
  const providerSessionTranscriptPath = boundedPath(record.providerSessionTranscriptPath)
  const providerSessionHome =
    boundedPath(record.providerSessionHome) ??
    deriveProviderSessionHome(providerSessionAgent, providerSessionTranscriptPath)
  return {
    providerSessionId,
    providerSessionAgent,
    ...(providerSessionTranscriptPath ? { providerSessionTranscriptPath } : {}),
    ...(providerSessionHome ? { providerSessionHome } : {})
  }
}

export function normalizeAutomationRunResume(raw: unknown): AutomationRunResume | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const requested = boundedText(record.requested, PROVIDER_SESSION_ID_MAX_LENGTH)
  const outcome = record.outcome
  if (!requested || (outcome !== 'resumed' && outcome !== 'fresh' && outcome !== 'failed')) {
    return null
  }
  const reason =
    typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim().slice(0, RESUME_REASON_MAX_LENGTH)
      : null
  return { requested, outcome, ...(reason ? { reason } : {}) }
}

/**
 * Applies one dispatch-result write's provider-session and resume fields to a run.
 * Absent keys keep the run's current values; an explicit null clears them. Returns a
 * new run object; the cleared keys are removed rather than left `undefined` so the
 * persisted record and strict equality in tests stay clean.
 */
export function applyAutomationRunProviderSessionResult<T extends AutomationRun>(
  run: T,
  result: Pick<AutomationDispatchResult, 'providerSession' | 'resume'>
): T {
  const providerSession = Object.hasOwn(result, 'providerSession')
    ? normalizeAutomationRunProviderSession(result.providerSession)
    : normalizeAutomationRunProviderSession(run)
  const resume = Object.hasOwn(result, 'resume')
    ? normalizeAutomationRunResume(result.resume)
    : normalizeAutomationRunResume(run.resume)
  const next: T = { ...run }
  delete next.providerSessionId
  delete next.providerSessionAgent
  delete next.providerSessionTranscriptPath
  delete next.providerSessionHome
  delete next.resume
  return { ...next, ...providerSession, ...(resume ? { resume } : {}) }
}

/** The recorded thread of a run, when the run has one for `agent`. */
export function readAutomationRunProviderSession(
  run: AutomationRun,
  agent: string
): AutomationRunProviderSession | null {
  const providerSession = normalizeAutomationRunProviderSession(run)
  return providerSession && providerSession.providerSessionAgent === agent ? providerSession : null
}
