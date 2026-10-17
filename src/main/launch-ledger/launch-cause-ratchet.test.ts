import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript-api'

const mainCreators = new Set([
  'createTerminal',
  'splitTerminal',
  'createAgentSession',
  'ensureAgentSession',
  'launchAgentTerminal',
  'createMobileSessionTerminal',
  'createDesktopCoordinator',
  'createExistingWorktreeWorkerTerminal'
])
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return sources(path)
    }
    return /\.[cm]?tsx?$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
      ? [path]
      : []
  })
}
describe('launch cause call-site ratchet', () => {
  it('requires every creator to declare its cause and prints offending file:line', () => {
    const root = resolve('.')
    const offenders: string[] = []
    let count = 0
    for (const lane of ['src/main', 'src/renderer'] as const) {
      for (const file of sources(join(root, lane))) {
        const source = ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        )
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const expression = node.expression
            const name = ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : ts.isIdentifier(expression)
                ? expression.text
                : ''
            const callee = expression.getText(source).replace(/\?\./g, '.')
            const creator =
              lane === 'src/main'
                ? mainCreators.has(name) ||
                  (name === 'spawn' && /(?:^|\.)ptyController\.spawn$/.test(callee))
                : callee === 'window.api.pty.spawn'
            // The notifier forwards a graph split to the renderer; main already records its cause hint.
            const graphForward = lane === 'src/main' && callee === 'this.notifier.splitTerminal'
            if (creator && !graphForward) {
              count++
              const args = node.arguments.map((arg) => arg.getText(source)).join('\n')
              const declared =
                lane === 'src/main'
                  ? /\blaunchCause\b/.test(args)
                  : /\blaunchTrigger\b|\.\.\.\s*launchAttributionSpawnFields\s*\(/.test(args)
              if (!declared) {
                offenders.push(
                  `${relative(root, file).split('\\').join('/')}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
                )
              }
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    console.log(`Launch cause ratchet: ${count} call sites; ${offenders.length} offenders`)
    expect(
      count,
      'source scan must find the established creator population'
    ).toBeGreaterThanOrEqual(54)
    expect(
      offenders,
      `Missing launch attribution (${offenders.length}/${count}):\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
