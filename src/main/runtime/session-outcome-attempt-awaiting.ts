import { parseAskFromStatus } from '../../shared/native-chat-ask'
import {
  sessionAttemptAwaitingSchema,
  type SessionAttemptAwaiting
} from '../../shared/session-attempt-recovery'

/**
 * A live agent asking its person something: a permission prompt or a question of its own. That is
 * a request to a person, never a failure, so it is recorded on `attempt.awaiting` and the attempt
 * stays `running` (`docs/reference/session-run-lifecycle.md`).
 */
type AskingHook = {
  state: string
  interactivePrompt: string | null
  lastAssistantMessage: string | null
  stateStartedAt?: number
}

const ASKING_STATES = ['waiting', 'blocked', 'permission']

export function agentHookIsAsking(
  hook: { state: string; interactivePrompt?: string | null } | null | undefined
): hook is AskingHook {
  return Boolean(
    hook &&
    (ASKING_STATES.includes(hook.state) ||
      // Why done: an async question (Codex's) rides the finished turn that asked it.
      (hook.state === 'done' && parseAskFromStatus(hook.interactivePrompt)?.delivery === 'async'))
  )
}

function clip(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > 2_000 ? `${collapsed.slice(0, 1_999)}…` : collapsed
}

/** The hook's prompt envelope in words: `{approval}` is a permission, `{questions}` a question. */
function readPrompt(hook: AskingHook): Pick<SessionAttemptAwaiting, 'kind' | 'prompt'> {
  let approval: { tool?: unknown; summary?: unknown } | undefined
  try {
    approval = (JSON.parse(hook.interactivePrompt ?? 'null') as { approval?: typeof approval })
      ?.approval
  } catch {
    approval = undefined
  }
  if (approval && typeof approval.tool === 'string') {
    const summary = typeof approval.summary === 'string' ? approval.summary : ''
    return { kind: 'permission', prompt: clip(`${approval.tool} ${summary}`) }
  }
  const questions = parseAskFromStatus(hook.interactivePrompt)?.questions ?? []
  const asked = clip(questions.map((entry) => entry.question).join(' '))
  return {
    kind: hook.state === 'permission' ? 'permission' : 'clarification',
    prompt:
      asked ||
      clip(hook.interactivePrompt ?? '') ||
      clip(hook.lastAssistantMessage ?? '') ||
      'The agent needs your input.'
  }
}

/** `since` survives re-observation of the same prompt, so the request it opens is one request. */
export function sessionAttemptAwaiting(
  hook: AskingHook,
  previous: SessionAttemptAwaiting | undefined,
  paneKey: string | null | undefined,
  now: number
): SessionAttemptAwaiting {
  const read = readPrompt(hook)
  const same = previous && previous.kind === read.kind && previous.prompt === read.prompt
  const pane = paneKey?.trim()
  const awaiting = {
    ...read,
    since: same ? previous.since : (hook.stateStartedAt ?? now),
    ...(pane && pane.length <= 200 ? { paneKey: pane } : {})
  }
  // A shape the set's strict schema refuses would cost the whole write; the plain ask always fits.
  return sessionAttemptAwaitingSchema.safeParse(awaiting).success
    ? awaiting
    : { kind: read.kind, prompt: 'The agent needs your input.', since: now }
}
