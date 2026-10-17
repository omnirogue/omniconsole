/**
 * The provider thread a routine run ran in, recorded on the run so a later run whose
 * pane is gone can resume it (`codex resume <id>` / `claude --resume <id>`), and the
 * outcome of such a resume request. Split from automations-types.ts for its line budget.
 */
export type AutomationRunProviderSessionAgent = 'codex' | 'claude'

export type AutomationRunProviderSession = {
  providerSessionId: string
  providerSessionAgent: AutomationRunProviderSessionAgent
  /** Hook-reported rollout/transcript path; main verifies provenance and pins the
   *  resume to the home that owns it. */
  providerSessionTranscriptPath?: string
  /** Account home the rollout lives in, derived from the transcript path. A resume
   *  never crosses homes: a different launch home means a fresh thread. */
  providerSessionHome?: string
}

export type AutomationRunResumeOutcome = 'resumed' | 'fresh' | 'failed'

/** Set only on runs that asked to resume an earlier run's thread. */
export type AutomationRunResume = {
  /** The provider thread id the launch asked to resume. */
  requested: string
  outcome: AutomationRunResumeOutcome
  reason?: string
}

/** The run-record half: the thread the pane ran and, when asked for, the resume outcome. */
export type RunThreadFields = {
  providerSessionId?: string
  providerSessionAgent?: AutomationRunProviderSessionAgent
  providerSessionTranscriptPath?: string
  providerSessionHome?: string
  resume?: AutomationRunResume
}

/** The dispatch-result half: absent keeps the run's values, null clears them. */
export type DispatchThreadFields = {
  providerSession?: AutomationRunProviderSession | null
  resume?: AutomationRunResume | null
}
