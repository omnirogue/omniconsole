import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

/**
 * A pursued run is opened the way a person opens any conversation: the row of its source pane in
 * Conversations. Only an open request to the owner lists it under Needs you (and so in Attention);
 * an active, waiting or recovering run sits in Active and a finished one under Done
 * (`docs/reference/session-run-lifecycle.md`).
 */
export type OutcomeRowPlace = 'anywhere' | 'active' | 'done'

const PLACE: Record<OutcomeRowPlace, string> = {
  anywhere: '',
  active: '[data-session-group="workspace:other"] ',
  done: '[data-session-group="completed"] '
}

/** Shows Conversations and returns the run's row in `place`, unfolding Done when it must. */
export async function outcomeConversationRow(
  page: Page,
  paneKey: string,
  place: OutcomeRowPlace = 'anywhere'
): Promise<Locator> {
  await page.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Session folders' })).toBeVisible()
  const row = page.locator(`${PLACE[place]}[data-session-row*="${paneKey}"]`).first()
  const unfoldDone = page
    .locator('[data-session-group="completed"]')
    .getByRole('button', { name: /^Expand / })
  await expect(async () => {
    // Why: Done starts folded, and a run that finished meanwhile has moved its row there.
    if (place !== 'active' && (await row.count()) === 0 && (await unfoldDone.count()) > 0) {
      await unfoldDone.click({ timeout: 2_000 })
    }
    await expect(row).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  return row
}

/** The run's row under Needs you: it is there only while the run asks its owner something. */
export function outcomeNeedsYouRow(page: Page, paneKey: string): Locator {
  return page.locator(`[data-session-group="attention"] [data-session-row*="${paneKey}"]`)
}

/** Opens the row's Up next and waits for its view: the header there states the run's phase. */
export async function openOutcomeUpNext(page: Page, row: Locator): Promise<Locator> {
  await row.getByRole('button', { name: 'Up next', exact: true }).click()
  const composer = page.locator('[data-up-next-composer]').last()
  await expect(composer.locator('[data-up-next-chain]')).toBeVisible({ timeout: 30_000 })
  // Why attached, not visible: a finished run with no blocks renders an empty (zero-height) track.
  await expect(composer.locator('[data-up-next-track]')).toBeAttached({ timeout: 30_000 })
  return composer
}
