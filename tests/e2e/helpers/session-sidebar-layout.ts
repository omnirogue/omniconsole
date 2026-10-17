import type { Page } from '@stablyai/playwright-test'
import type { SessionSidebarLayout } from '../../../src/renderer/src/lib/session-sidebar-view'
import './runtime-types'

/**
 * Pins the Conversations sidebar to the full tree (or the five-line focus view) in this profile;
 * null leaves the default. Why: a fresh profile opens in the focus view, and specs about the full
 * tree must not depend on it.
 */
export async function seedSessionSidebarLayout(
  page: Page,
  layout: SessionSidebarLayout | null
): Promise<void> {
  if (!layout) {
    return
  }
  await page.waitForFunction(() => Boolean(window.__sessionSidebarViewE2E), null, {
    timeout: 30_000
  })
  await page.evaluate((next) => window.__sessionSidebarViewE2E!.setLayout(next), layout)
}
