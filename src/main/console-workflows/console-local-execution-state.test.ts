import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleProcessObservationFixture } from './console-job-process-observation.test-fixture'
import { observeConsoleJobProcess } from './console-job-process-observation'

describe('local execution views retain physical process evidence', () => {
  let fixture: ReturnType<typeof createConsoleProcessObservationFixture>
  beforeEach(() => {
    fixture = createConsoleProcessObservationFixture()
  })
  afterEach(() => {
    fixture.db.close()
    vi.restoreAllMocks()
  })

  it.each(['succeeded', 'failed'] as const)(
    'keeps worker_done %s unverifiable until the host exit is committed',
    async (outcome) => {
      fixture.settle(outcome)
      expect(fixture.record().view.state).toBe('unverifiable')
      fixture.exit(37)
      expect(await observeConsoleJobProcess(fixture.runtime, fixture.identity)).toMatchObject({
        state: 'exited'
      })
      expect(fixture.record().view.state).toBe('exited')
    }
  )

  it('preserves a committed physical exit even before a worker report arrives', async () => {
    expect(fixture.record().view.state).toBe('running')
    fixture.exit(null, 9)
    await observeConsoleJobProcess(fixture.runtime, fixture.identity)
    expect(fixture.record().worker.state).toBe('ready')
    expect(fixture.record().view.state).toBe('exited')
  })
})
