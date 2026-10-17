/** The smallest provider default; an implicit timeout retry must stay below it. */
export const WORKFLOW_FROZEN_TIMEOUT_MS = 120_000
/** The longest a program may give one call; a longer request is capped, not refused. */
export const WORKFLOW_MAX_CALL_TIMEOUT_MS = 60 * 60_000
/**
 * A streaming call silent this long is ended, process group included, and retried once: its CLI
 * reports progress as it works, so silence means it is stuck rather than thinking.
 */
export const WORKFLOW_CALL_STALL_MS = 10 * 60_000

/** Stream-mode CLIs report as they work; the HTTP workers stay silent through one completion. */
export function workflowCallStallMs(stream: boolean, agent: string): number | undefined {
  return stream && agent !== 'openrouter' && agent !== 'ollama' ? WORKFLOW_CALL_STALL_MS : undefined
}
/** A local model first loads into memory and then answers at this computer's pace. */
export const WORKFLOW_OLLAMA_FROZEN_TIMEOUT_MS = 15 * 60_000

/**
 * The program's own per-call timeout as the process runs under it (whole milliseconds, capped),
 * or undefined when the call has none and the launch mode's default applies.
 */
export function workflowCallTimeoutMs(requested: number | undefined): number | undefined {
  return requested !== undefined && Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.round(requested), WORKFLOW_MAX_CALL_TIMEOUT_MS)
    : undefined
}
