import { writeFileSync } from 'node:fs'
import type { Locator, Page, TestInfo } from '@playwright/test'

export async function captureRoutineProof(
  page: Page,
  testInfo: TestInfo,
  name: string,
  surface: Locator = page.locator('body')
): Promise<void> {
  const snapshot = testInfo.outputPath(`${name}.txt`)
  writeFileSync(snapshot, await surface.ariaSnapshot())
  await testInfo.attach(name, { path: snapshot, contentType: 'text/plain' })
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) })
}
