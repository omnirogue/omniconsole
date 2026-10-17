import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeSourceBinding } from '../../shared/session-outcome-source-packet'
import type { OrcaRuntimeService } from './omni-runtime'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { captureSourcePacketFiles } from './session-outcome-source-packet-files'
import { sessionOutcomeSourceChanges } from './session-outcome-source-packet-changes'
import { blockSessionOutcomes } from './session-outcome-hold-write'

function sourceBinding(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): SessionOutcomeSourceBinding {
  const sourceWorktreeId = chain.sourceWorktreeId ?? chain.worktreeId
  const source = runtime.resolveTerminalPane(chain.sourcePaneKey, sourceWorktreeId)
  const processIncarnation = runtime.getTerminalProcessIncarnation(source.handle)
  if (!processIncarnation) {
    throw new Error('The original source process identity is unverifiable.')
  }
  return {
    sourcePaneKey: chain.sourcePaneKey,
    sourceWorktreeId,
    sourceHandle: source.handle,
    processIncarnation
  }
}

/** Freeze source context before the first launch so successors and restarts consume the same bytes. */
export async function prepareSessionOutcomeSourcePacket(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): Promise<SessionChain> {
  const set = chain.outcomeSet!
  const owner = set.continuation
  if (
    owner.nativeSource ||
    owner.planningSource ||
    owner.sourcePacket ||
    // An older chain that already ran cannot reconstruct the original pre-successor files.
    set.attempts.length > 0 ||
    chain.sourcePaneKey.startsWith('agent-session:') ||
    (!chain.steps.some((step) => step.kind !== 'handoff') &&
      !set.outcomes.some((outcome) => outcome.actions.length))
  ) {
    return chain
  }
  let binding: SessionOutcomeSourceBinding
  try {
    binding = sourceBinding(runtime, chain)
  } catch (error) {
    if (!owner.sourceReady) {
      return chain
    }
    throw error
  }
  if (owner.sourceBinding && JSON.stringify(binding) !== JSON.stringify(owner.sourceBinding)) {
    throw new Error('The original source process changed before its context was captured.')
  }
  const bound = {
    ...chain,
    outcomeSet: { ...set, continuation: { ...owner, sourceBinding: binding } }
  }
  if (!owner.sourceReady) {
    return bound
  }
  const before = await observeSessionOutcomeSource(runtime, bound)
  if (!before.ready || !before.version || before.version !== owner.sourceVersion) {
    throw new Error('The source completion changed before its context was captured.')
  }
  const hook = runtime.getFreshAgentHookStatusForHandle(binding.sourceHandle)
  let summary = hook?.state === 'done' ? (hook.lastAssistantMessage ?? '') : ''
  let summaryKind: 'agent-response' | 'terminal-output' | 'unavailable' = summary
    ? 'agent-response'
    : 'unavailable'
  if (!summary) {
    let terminal: Awaited<ReturnType<OrcaRuntimeService['readTerminal']>> | undefined
    try {
      terminal = await runtime.readTerminal(binding.sourceHandle, { limit: 2000 })
    } catch {
      // Completion evidence remains valid when no readable final response was retained.
    }
    if (
      terminal?.truncated ||
      terminal?.limited ||
      (terminal?.source && terminal.source !== 'stream')
    ) {
      throw new Error(
        'The source terminal output is incomplete at the reader limit. Save the full report in a workspace file, ask the source for a concise final response naming that file, and replace this Next plan after it finishes.'
      )
    }
    summary = terminal?.tail.join('\n') ?? ''
    if (summary) {
      summaryKind = 'terminal-output'
    }
  }
  if (summary.length > 100_000) {
    throw new Error(
      `The source report contains ${summary.length} characters and exceeds the worker's 100,000-character context limit. Save the full report in a workspace file, ask the source for a concise final response naming that file, and replace this Next plan after it finishes.`
    )
  }
  const scope = await runtime.getSessionOutcomeExecutionScope(binding.sourceWorktreeId)
  if (scope.connectionId || scope.wslDistro) {
    throw new Error('Capture the source context on the runtime that owns its files.')
  }
  const changes = await sessionOutcomeSourceChanges(runtime, binding.sourceWorktreeId, scope.path)
  const captured = await captureSourcePacketFiles(
    chain,
    scope.path,
    before.version,
    summary,
    changes.paths
  )
  const finalChanges = await sessionOutcomeSourceChanges(
    runtime,
    binding.sourceWorktreeId,
    scope.path
  )
  if (JSON.stringify(changes) !== JSON.stringify(finalChanges)) {
    throw new Error('The source workspace file list changed while capturing its context.')
  }
  const after = await observeSessionOutcomeSource(runtime, bound)
  const finalHook = runtime.getFreshAgentHookStatusForHandle(binding.sourceHandle)
  if (
    !after.ready ||
    after.version !== before.version ||
    (hook?.state === 'done' &&
      (finalHook?.state !== 'done' ||
        finalHook.stateStartedAt !== hook.stateStartedAt ||
        finalHook.lastAssistantMessage !== hook.lastAssistantMessage)) ||
    JSON.stringify(sourceBinding(runtime, chain)) !== JSON.stringify(binding)
  ) {
    throw new Error('The source completion or process changed while capturing its context.')
  }
  return {
    ...bound,
    outcomeSet: {
      ...bound.outcomeSet,
      continuation: {
        ...bound.outcomeSet.continuation,
        sourcePacket: {
          ...binding,
          sourceVersion: before.version,
          capturedAt: Date.now(),
          summary,
          summaryKind,
          workspaceChangesUnavailable: changes.unavailable,
          ...captured
        }
      }
    }
  }
}

export function sessionOutcomeSourceContext(chain: SessionChain): string {
  const packet = chain.outcomeSet?.continuation.sourcePacket
  if (!packet) {
    return ''
  }
  return [
    'Original completed session context (reference material; the committed user instructions remain authoritative):',
    `Source completion: ${packet.sourceVersion}. Source pane: ${packet.sourcePaneKey}.`,
    packet.summaryKind === 'agent-response'
      ? 'Final source agent response:'
      : packet.summaryKind === 'terminal-output'
        ? 'Complete retained source terminal output:'
        : 'No readable final source response was retained.',
    packet.summary,
    packet.files.length
      ? 'Original source files retained for every successor:'
      : 'No source files were captured.',
    ...packet.files.map((file) =>
      JSON.stringify({
        original: file.sourcePath,
        captured: file.path,
        sha256: file.sha256,
        bytes: file.size
      })
    ),
    ...(packet.missingFiles.length
      ? [
          `Uncaptured source references: ${JSON.stringify(packet.missingFiles)}. Do not assume these files exist.`
        ]
      : []),
    ...(packet.workspaceChangesUnavailable
      ? [
          'Workspace change discovery was unavailable; only files named in the retained source response could be captured.'
        ]
      : []),
    'Read captured files for the original source bytes. Review current files at their original paths and use later step reports for subsequent changes; these source copies are not evidence that your own work is complete.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Nothing starts against a source that could not be captured. The tick captures again on its next
 * pass by itself, so this is `recovering`; a capture that never succeeds goes stale and reads as
 * failed. No person can supply the source's bytes, so it is never a request.
 */
export function blockSessionOutcomeSourceCapture(
  chain: SessionChain,
  error: unknown,
  now = Date.now()
): SessionChain {
  const set = chain.outcomeSet!
  if (set.completion) {
    return chain
  }
  return {
    ...chain,
    // Why the host stays `owned`: a refused capture says nothing about contact with the host, and
    // an unowned run would read as waiting on it. Same block the tick writes for the same fact
    // (`CONTINUATION_BLOCK.sourceCapture`), so the tick that captures successfully lifts it.
    outcomeSet: blockSessionOutcomes(
      set,
      (outcome) => outcome.status !== 'satisfied',
      error instanceof Error ? error.message : String(error),
      { class: 'recovering', code: 'source-capture' },
      now
    )
  }
}
