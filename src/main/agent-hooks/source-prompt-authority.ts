import { createHash } from 'node:crypto'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { isNewTurnEvent } from '../../shared/agent-hook-listener/provider-event-routing'
import { nextOutcomeDiscoveryInstruction } from '../../shared/next-outcome-intent-instructions'
import { nextStepChatSubmissionSource } from '../../shared/next-step-chat-submission'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import {
  SOURCE_PROMPT_MAX_LENGTH,
  submittedHookSourcePrompt
} from '../../shared/submitted-hook-prompt'
export {
  SOURCE_PROMPT_MAX_LENGTH,
  submittedHookPromptText
} from '../../shared/submitted-hook-prompt'

const MAX_PROMPT_LENGTH = SOURCE_PROMPT_MAX_LENGTH
export type SourcePromptRecord = {
  paneKey: string
  worktreeId: string
  connectionId: string | null
  launchTokenHash: string
  providerSession: string | null
  prompt: string
  observedAt: number
}

function stripDiscovery(prompt: string): string | null {
  const chatSource = nextStepChatSubmissionSource(prompt)
  if (chatSource !== undefined) {
    return chatSource
  }
  if (!prompt.startsWith('<!-- omni-outcome-source-v1 -->')) {
    return prompt
  }
  for (const cli of ['omni', 'omni-dev', 'omni-ide', 'omni.cmd']) {
    const prefix = `${nextOutcomeDiscoveryInstruction(cli)}\n\n`
    if (prompt.startsWith(prefix)) {
      return prompt.slice(prefix.length)
    }
  }
  // Unknown injected guidance is not a user-authorized source.
  return null
}

function submittedPrompt(event: AgentHookEventPayload, body: unknown): string | null {
  const text = submittedHookSourcePrompt(event, body)
  return text === null ? null : stripDiscovery(text)
}

/** Full submissions live beside hook authority commitments, never in public status previews. */
export class SourcePromptAuthority {
  private readonly records = new Map<string, SourcePromptRecord>()

  observe(event: AgentHookEventPayload, rawBody: unknown): void {
    if (event.isReplay || event.toolAgentId) {
      return
    }
    this.invalidate(event)
    const token = event.launchToken?.trim()
    const hash = token ? createHash('sha256').update(token).digest('hex') : null
    const providerSession = event.providerSession ? JSON.stringify(event.providerSession) : null
    if (!event.hasExplicitPrompt) {
      return
    }
    this.records.delete(event.paneKey)
    const prompt = submittedPrompt(event, rawBody)
    if (!hash || !event.worktreeId || !prompt?.trim() || prompt.length > MAX_PROMPT_LENGTH) {
      return
    }
    this.records.set(event.paneKey, {
      paneKey: event.paneKey,
      worktreeId: event.worktreeId,
      connectionId: event.connectionId,
      launchTokenHash: hash,
      providerSession,
      prompt,
      observedAt: Date.now()
    })
  }

  invalidate(event: AgentHookEventPayload): boolean {
    if (event.toolAgentId) {
      return false
    }
    const prior = this.records.get(event.paneKey)
    if (!prior) {
      return false
    }
    const providerSession = event.providerSession ? JSON.stringify(event.providerSession) : null
    const token = event.launchToken?.trim()
    if (
      event.hasExplicitPrompt ||
      (event.source && isNewTurnEvent(event.source, event.hookEventName)) ||
      (providerSession && prior.providerSession && providerSession !== prior.providerSession) ||
      (token && createHash('sha256').update(token).digest('hex') !== prior.launchTokenHash)
    ) {
      this.records.delete(event.paneKey)
      return true
    }
    return false
  }

  read(candidate: {
    paneKey: string
    launchTokenHash: string
    connectionId: string | null
    worktreeId?: string
  }): string | undefined {
    const record = this.records.get(candidate.paneKey)
    return record &&
      record.launchTokenHash === candidate.launchTokenHash &&
      record.connectionId === candidate.connectionId &&
      record.worktreeId === candidate.worktreeId
      ? record.prompt
      : undefined
  }

  clear(paneKey?: string): void {
    if (paneKey) {
      this.records.delete(paneKey)
    } else {
      this.records.clear()
    }
  }

  snapshot(): SourcePromptRecord[] {
    return [...this.records.values()]
  }

  hydrate(
    value: unknown,
    commitments: ReadonlyMap<
      string,
      { launchTokenHash: string; connectionId: string | null; worktreeId?: string }
    >
  ): void {
    this.records.clear()
    if (!Array.isArray(value)) {
      return
    }
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') {
        continue
      }
      const record = raw as SourcePromptRecord
      const claim = commitments.get(record.paneKey)
      if (
        !claim ||
        claim.launchTokenHash !== record.launchTokenHash ||
        claim.connectionId !== record.connectionId ||
        claim.worktreeId !== record.worktreeId ||
        typeof record.prompt !== 'string' ||
        !record.prompt.trim() ||
        isKnownHarnessInjectedUserTurnText(record.prompt) ||
        record.prompt.length > MAX_PROMPT_LENGTH ||
        !(record.providerSession === null || typeof record.providerSession === 'string') ||
        !Number.isFinite(record.observedAt) ||
        record.observedAt > Date.now() ||
        Date.now() - record.observedAt > 7 * 24 * 60 * 60 * 1000
      ) {
        continue
      }
      this.records.set(record.paneKey, { ...record })
    }
  }
}
