import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'

const fixtures: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.service.dispose()
    f.db.close()
    await rm(f.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
it.each([false, true])(
  'distinguishes pre-claim refusal from an uncertain activation (claimed=%s)',
  async (claimed) => {
    const f = await createConsoleLocalExecutionFixture({ workspaceKind: 'folder' })
    fixtures.push(f)
    const refused = {
      ok: false as const,
      error: { code: 'unavailable', message: 'Temporary service failure' }
    }
    if (claimed) {
      vi.mocked(f.port.activate).mockResolvedValue(refused)
    } else {
      vi.mocked(f.port.getReadyJob).mockResolvedValue(refused)
    }
    const result = await f.service.start({
      jobId: f.job.id,
      workflowId: f.job.workflowId,
      approvedDigest: f.job.digest,
      worktree: 'id:source'
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'unavailable',
        launchDisposition: claimed ? 'unverifiable' : 'not-started'
      }
    })
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    if (!claimed) {
      expect(f.port.activate).not.toHaveBeenCalled()
    }
  }
)
