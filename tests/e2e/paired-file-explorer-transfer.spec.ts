import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  selectPairedWorktreeGroup,
  waitForPairedWorktreeId
} from './helpers/client-hosted-browser-fixture'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('keeps local Copy and downloads paired files without offering paired Copy', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const repoPath = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    return state.allWorktrees().find((entry) => entry.id === state.activeWorktreeId)!.path
  })
  const name = 'paired-transfer-audit.bin'
  const folderName = 'paired-transfer-audit-folder'
  const sourcePath = path.join(repoPath, name)
  const folderPath = path.join(repoPath, folderName)
  const destinationDir = mkdtempSync(path.join(os.tmpdir(), 'orca-transfer-download-'))
  const destinationPath = path.join(destinationDir, name)
  const content = Buffer.alloc(1024 * 1024, 'paired runtime transfer\n')
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  writeFileSync(sourcePath, content)
  mkdirSync(folderPath)

  try {
    await openFileExplorer(orcaPage)
    await orcaPage.getByRole('button', { name: 'Refresh Explorer', exact: true }).click()
    const localFile = orcaPage.locator('[data-file-explorer-row]').filter({ hasText: name })
    await localFile.click({ button: 'right' })
    await expect(orcaPage.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('menuitem', { name: 'Download', exact: true })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.getByRole('menu')).toHaveCount(0)
    await orcaPage
      .locator('[data-file-explorer-row]')
      .filter({ hasText: folderName })
      .click({ button: 'right' })
    await expect(orcaPage.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.getByRole('menu')).toHaveCount(0)

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const client = await launchPairedElectronClient(offer, testInfo, 'Explorer transfer audit')
    try {
      const worktreeId = await waitForPairedWorktreeId(client.page, repoPath)
      await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
      await openFileExplorer(client.page)
      await client.page.getByRole('button', { name: 'Refresh Explorer', exact: true }).click()
      const remoteFile = client.page.locator('[data-file-explorer-row]').filter({ hasText: name })
      await remoteFile.click({ button: 'right' })
      await expect(client.page.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveCount(0)
      await expect(
        client.page.getByRole('menuitem', { name: 'Download', exact: true })
      ).toBeVisible()
      await testInfo.attach('paired-file-menu', {
        body: await client.page.screenshot(),
        contentType: 'image/png'
      })
      await client.page.keyboard.press('Escape')
      await expect(client.page.getByRole('menu')).toHaveCount(0)
      await client.app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, destinationPath)
      await remoteFile.click({ button: 'right' })
      await client.page.getByRole('menuitem', { name: 'Download', exact: true }).click()
      await expect(client.page.getByText(`Downloaded '${name}'`, { exact: true })).toBeVisible()
      await expect(client.page.getByRole('menu')).toHaveCount(0)
      expect(digest(readFileSync(destinationPath))).toBe(digest(content))

      await client.page
        .locator('[data-file-explorer-row]')
        .filter({ hasText: folderName })
        .click({ button: 'right' })
      await expect(client.page.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveCount(0)
      await expect(
        client.page.getByRole('menuitem', { name: 'Download Folder', exact: true })
      ).toHaveCount(0)
      await expect(
        client.page.getByRole('menuitem', { name: 'Rename', exact: false })
      ).toBeVisible()
    } finally {
      await client.dispose()
    }
  } finally {
    rmSync(sourcePath, { force: true })
    rmSync(folderPath, { recursive: true, force: true })
    rmSync(destinationDir, { recursive: true, force: true })
  }
})
