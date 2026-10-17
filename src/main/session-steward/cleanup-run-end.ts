/**
 * The End finish action for a cleanup session: once its report is saved (the run is `completed`),
 * the window is asked to end the session with the same "When finished: End" a person can pick, so
 * it closes only after its host confirms the session finished. Retried while no window answers.
 */

import type { AutomationRun } from '../../shared/automations-types'
import type { SessionManageRendererRequest } from '../../shared/session-manage-relay'

const END_ATTEMPTS = 10

export class CleanupRunEnds {
  private readonly pending = new Map<string, number>()

  constructor(
    private readonly relay: (request: SessionManageRendererRequest) => Promise<unknown>,
    private readonly findRun: (runId: string) => AutomationRun | undefined
  ) {}

  request(run: AutomationRun): void {
    if (!run.terminalPaneKey && !run.terminalSessionId) {
      return
    }
    this.pending.set(run.id, (this.pending.get(run.id) ?? 0) + 1)
    void this.relay({
      kind: 'scheduleFinish',
      ...(run.terminalPaneKey ? { paneKey: run.terminalPaneKey } : {}),
      ...(run.terminalSessionId ? { tabId: run.terminalSessionId } : {}),
      action: 'end'
    }).then(
      () => this.pending.delete(run.id),
      () => undefined
    )
  }

  retry(): void {
    for (const [runId, attempts] of this.pending) {
      const run = attempts < END_ATTEMPTS ? this.findRun(runId) : undefined
      if (run) {
        this.request(run)
      } else {
        this.pending.delete(runId)
      }
    }
  }
}
