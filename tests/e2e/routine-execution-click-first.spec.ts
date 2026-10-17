import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Automation, AutomationRun } from '../../src/shared/automations-types'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { waitForRoutineWorkspace } from './helpers/routine-workspace-readiness'

// Real scheduler → IPC dispatch → PTY process → file output → durable run history.
// The provider is a deterministic local process so this regression needs no paid API account.
test('scheduled routine executes a normal session and records its result after the work finishes', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(200_000)
  await waitForSessionReady(orcaPage)
  const workspaceId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForRoutineWorkspace(orcaPage, workspaceId)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-routine-execution-'))
  const script = path.join(scratch, 'routine-provider.cjs')
  const output = path.join(scratch, 'result.txt')
  const marker = 'ROUTINE_E2E_EXECUTED'
  writeFileSync(
    script,
    `const fs = require('node:fs');
const status = (state, extra = {}) => process.stdout.write('\\x1b]9999;' + JSON.stringify({state, prompt: '', agentType: 'codex', ...extra}) + '\\x07');
status('done', {sessionBoundary: true});
process.stdout.write('› Ask Codex to do anything\\n');
setTimeout(() => { status('working', {prompt: process.argv.at(-1)}); process.stdout.write('\\x1b]0;Codex — working\\x07'); }, 1000);
setTimeout(() => { fs.writeFileSync(${JSON.stringify(output)}, process.argv.at(-1)); process.stdout.write('\\n${marker}\\n'); status('done', {lastAssistantMessage: '${marker}'}); process.stdout.write('\\x1b]0;Codex — idle\\x07'); }, 3500);
setTimeout(() => process.exit(0), 20000);
`
  )
  try {
    const automationId = await orcaPage.evaluate(
      async ({ workspaceId, command, marker }) => {
        const state = window.__store!.getState()
        await state.updateSettingsOrThrow({
          agentCmdOverrides: { codex: command },
          agentDefaultArgs: { codex: '-s read-only -a on-request' }
        })
        const worktree = state.getKnownWorktreeById(workspaceId)!
        const created = await window.api.runtime.call({
          method: 'automation.create',
          params: {
            name: 'Scheduled execution proof',
            prompt: marker,
            agentId: 'codex',
            workspaceMode: 'existing',
            workspace: `id:${worktree.id}`,
            reuseSession: false,
            timezone: 'UTC',
            rrule: '* * * * *',
            dtstart: Date.now(),
            enabled: true,
            missedRunGraceMinutes: 720
          }
        })
        if (!created.ok) {
          throw new Error(created.error.message)
        }
        state.openAutomationsPage()
        return (created.result as { automation: { id: string } }).automation.id
      },
      {
        workspaceId,
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        marker
      }
    )
    await orcaPage.getByRole('button', { name: /^Scheduled execution proof/ }).click()
    await orcaPage.getByRole('tab', { name: /^Runs/ }).click()
    // A 60s scheduler tick can fall just before the first minute boundary.
    try {
      await expect(orcaPage.getByText('1 run · 1 completed', { exact: true })).toBeVisible({
        timeout: 145_000
      })
    } catch (error) {
      const evidence = await orcaPage.evaluate(
        async (automationId) =>
          window.api.runtime.call({ method: 'automation.runs', params: { automationId } }),
        automationId
      )
      await testInfo.attach('routine-history.json', {
        body: JSON.stringify(evidence),
        contentType: 'application/json'
      })
      throw error
    }
    expect(readFileSync(output, 'utf8')).toContain(marker)
    expect(readFileSync(output, 'utf8')).toContain('routine-result')
    const receipt = await orcaPage.evaluate(async (automationId) => {
      const [definition, history] = await Promise.all([
        window.api.runtime.call({ method: 'automation.show', params: { id: automationId } }),
        window.api.runtime.call({ method: 'automation.runs', params: { automationId } })
      ])
      if (!definition.ok || !history.ok) {
        throw new Error('Could not read the scheduled run receipt')
      }
      return {
        automation: (definition.result as { automation: Automation }).automation,
        run: (history.result as { runs: AutomationRun[] }).runs[0]!
      }
    }, automationId)
    expect(receipt.run.trigger).toBe('scheduled')
    expect(receipt.run.outputSnapshot!.capturedAt).toBeGreaterThanOrEqual(
      Math.floor(statSync(output).mtimeMs)
    )
    expect(receipt.automation.nextRunAt).toBeGreaterThan(receipt.run.scheduledFor)
    await testInfo.attach('scheduled-run-receipt.json', {
      body: JSON.stringify(receipt, null, 2),
      contentType: 'application/json'
    })
    await orcaPage
      .getByRole('tabpanel', { name: /^Runs/ })
      .getByRole('button', { name: /\bDone\b/ })
      .click()
    // The prompt also contains the marker; verify the result disclosure in run history.
    await expect(orcaPage.getByText(marker, { exact: true }).last()).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('scheduled-result.png') })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
