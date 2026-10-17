import type { Page } from '@stablyai/playwright-test'
import {
  FLEET_UI_FIXTURE_MACHINE,
  FLEET_UI_FIXTURE_TITLE,
  seedFleetDispatchUiConversation
} from './fleet-dispatch-ui-fixture'

export async function seedRecoveredFleetDispatchUiConversation(page: Page): Promise<void> {
  await seedFleetDispatchUiConversation(page)
  // Why: the hand composer is disabled; this fixture exercises recovery of already-admitted work.
  await page.evaluate(
    async ({ title, machine }) => {
      const preview = await window.api.consoleWorkflows.previewFleetTask({
        taskId: 'btk_fixturefleet',
        expectedRevision: 4,
        classification: {
          title,
          company_slug: 'fixture',
          execution_mode: 'single_shot',
          steps: [{ key: 'continue', title, actor_type: 'ai', actor_id: 'codex:fixture-model' }]
        },
        prompt: 'Fixture: improve this proposal.',
        fanoutAck: false,
        source: { sessionRef: 'fixture-recovered-row', sessionId: 'fixture-source-session' }
      })
      if (!preview.ok) {
        throw new Error(preview.error.message)
      }
      const admitted = await window.api.consoleWorkflows.admitFleetTask({
        taskId: 'btk_fixturefleet',
        expectedRevision: 4,
        graph: preview.data.graph,
        digest: preview.data.digest,
        contextDigest: preview.data.admission.context_digest,
        adoptStage: preview.data.admission.adopt_stage
      })
      if (!admitted.ok) {
        throw new Error(admitted.error.message)
      }
      const store = window.__store!
      await store.getState().updateSettings({ backofficeProductionUrl: 'https://fixture.invalid' })
      const state = store.getState()
      store.setState({
        sshTargetLabels: new Map([...state.sshTargetLabels, ['fixture-ssh', machine]]),
        repos: [
          ...state.repos,
          {
            ...state.repos[0],
            id: 'fixture-remote-repo',
            path: '/fixture-only/remote',
            connectionId: 'fixture-ssh',
            executionHostId: 'ssh:fixture-ssh'
          }
        ]
      })
      window.dispatchEvent(new Event('focus'))
    },
    { title: FLEET_UI_FIXTURE_TITLE, machine: FLEET_UI_FIXTURE_MACHINE }
  )
}
