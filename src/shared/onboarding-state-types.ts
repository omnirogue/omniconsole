// Subset of onboarding Ghostty DiscoveryState statuses that emit telemetry; UI-only 'idle'/'detecting' don't.
export type DiscoveryStatusEmitted = 'found' | 'absent' | 'imported'

export type OnboardingOutcome = 'completed' | 'dismissed'

export type OnboardingChecklistState = {
  addedRepo: boolean
  choseAgent: boolean
  ranFirstAgent: boolean
  ranSecondAgentOnSameTask: boolean
  triedCmdJ: boolean
  shapedSidebar: boolean
  reviewedDiff: boolean
  openedPr: boolean
  addedFolder: boolean
  openedFile: boolean
  ranAgentOnFile: boolean
  // Why: UI state flag (panel visibility), not an activation event; telemetry checklist enum omits it.
  dismissed: boolean
}

export type OnboardingWizardStepId =
  | 'account'
  | 'agent'
  | 'theme'
  | 'integrations'
  | 'windows_terminal'
  | 'notifications'

export type OnboardingState = {
  // Why: step meanings change when pages are added/removed; version marker prevents migration re-running on new progress.
  flowVersion: number
  closedAt: number | null
  outcome: OnboardingOutcome | null
  // Sentinel -1 = not started; 1..6 = highest finished wizard step. number (not union) because callers clamp via Math.max/min.
  lastCompletedStep: number
  checklist: OnboardingChecklistState
}

