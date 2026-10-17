import { expect, type Page } from '@playwright/test'

/** Runtime selectors need the host catalog, not only a hydrated renderer workspace. */
export async function waitForRoutineWorkspace(page: Page, workspaceId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (worktree) => window.api.runtime.call({ method: 'worktree.show', params: { worktree } }),
        `id:${workspaceId}`
      )
    )
    .toMatchObject({ ok: true })
}
