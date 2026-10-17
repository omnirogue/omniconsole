import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import { readFirstString } from './agent-hook-listener/interactive-tool'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import {
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState
} from './agent-hook-listener/providers/codex-state'
import type { AgentHookSource } from './agent-hook-relay'
import { reconcileCodexSubagentTranscript } from './codex-subagent-transcript'

export async function prepareCodexHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string,
  canCommit: () => boolean = () => true
): Promise<boolean> {
  if (!canCommit()) {
    return false
  }
  if (source !== 'codex') {
    return true
  }
  const envelope = parseHookEnvelope(state, source, body, expectedEnv)
  if (!envelope) {
    return true
  }
  const { record, paneKey, hookPayloadRecord } = envelope
  const previousTranscript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (previousTranscript) {
    previousTranscript.backlogProgress = false
  }
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    hookPayloadRecord.hook_event_name ??
    hookPayloadRecord.hookEventName
  if (eventName === 'SessionStart' || hookPayloadRecord.agent_id) {
    return true
  }
  const path = readFirstString(hookPayloadRecord, ['transcript_path', 'transcriptPath'])
  if (!path) {
    return true
  }
  const transcriptState = getOrCreateCodexSubagentTranscriptState(state, paneKey)
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  const isCurrent = () =>
    canCommit() &&
    state.codexSubagentTranscriptByPaneKey.get(paneKey) === transcriptState &&
    state.codexSubagentRosterByPaneKey.get(paneKey) === roster
  await reconcileCodexSubagentTranscript(transcriptState, roster, path, isCurrent)
  return isCurrent()
}
