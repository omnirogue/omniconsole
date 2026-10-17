import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript-api'
import { launchHeadlessAutomationTerminal } from '../automations/headless-dispatch'

// The index callback is the seam where both automation.id and run.id are in scope.
it.each([false, true])(
  'headless routine with reuse=%s forwards both owner ids to launchAgentTerminal',
  async (reuseSession) => {
    const file = resolve('src/main/index.ts')
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const calls: ts.CallExpression[] = []
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'launchHeadlessAutomationTerminal'
      ) {
        calls.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls).toHaveLength(1)
    const launchAgentTerminal = vi.fn().mockResolvedValue({ handle: 'term-1' })
    const code = ts.transpileModule(
      // liveThreads and outputBinding are the callback's own locals the call reads.
      `async function invoke(runtimeService, automation, run, agentTemplate, buildRoutineRunPrompt, routineLaunchPreferences, launchHeadlessAutomationTerminal, automationStore, agentHookServer, liveThreads, outputBinding) { return await ${calls[0].getText(source)} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
    ).outputText
    const invoke = new Function(`${code}; return invoke`)()
    await invoke(
      { launchAgentTerminal },
      { id: 'auto-1', workspaceId: 'wt-1', agentId: 'claude', prompt: 'routine', reuseSession },
      { id: 'run-1', title: 'Routine run' },
      null,
      () => 'routine prompt',
      () => undefined,
      launchHeadlessAutomationTerminal,
      {
        listAutomationRuns: () => [
          {
            id: 'prior',
            automationId: 'auto-1',
            workspaceId: 'wt-1',
            status: 'completed',
            createdAt: 0,
            providerSessionAgent: 'claude',
            providerSessionId: 'thread-1'
          }
        ],
        automationOwnerPrecondition: () => ({ selector: { kind: 'self' } })
      },
      { getStatusSnapshot: () => [] },
      [],
      undefined
    )
    expect(launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(launchAgentTerminal.mock.calls[0]?.[1]?.resumeProviderSession?.id).toBe(
      reuseSession ? 'thread-1' : undefined
    )
    expect(launchAgentTerminal.mock.calls[0]?.[1]?.launchCause).toEqual({
      trigger: 'automation',
      reference: { automationId: 'auto-1', automationRunId: 'run-1' }
    })
  }
)
