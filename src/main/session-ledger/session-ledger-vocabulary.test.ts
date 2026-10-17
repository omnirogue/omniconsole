import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const forbidden = /transcript|recording/i
const sidebar = 'src/renderer/src/components/sidebar/team-sessions'

function source(path: string): ts.SourceFile {
  const file = join(root, path)
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function productionFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      // Test descriptions and fixtures inside test files are not shipped to a caller.
      return entry.isDirectory()
        ? productionFiles(path)
        : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
          ? [path]
          : []
    })
    .sort()
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function hit(file: ts.SourceFile, node: ts.Node, value: string): string[] {
  if (!forbidden.test(value)) {
    return []
  }
  const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  return [`${relative(root, file.fileName)}:${line}: ${JSON.stringify(value)}`]
}

function privateMainLiteral(node: ts.Node, file: ts.SourceFile): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
      return true
    }
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText(file)
      // These reviewed sinks only log locally; returned/thrown errors are still scanned.
      if (
        (file.fileName === join(root, 'src/main/session-ledger/ledger-event-queue.ts') &&
          callee === 'this.warn') ||
        (file.fileName === join(root, 'src/main/session-ledger/ledger-service.ts') &&
          callee === 'this.deps.warn') ||
        /^console\.(warn|error|info|debug|log)$/.test(callee)
      ) {
        return true
      }
    }
  }
  return false
}

function literalHits(file: ts.SourceFile, subtree: ts.Node = file, main = false): string[] {
  const hits: string[] = []
  // AST traversal excludes comments because comments are not wire/UI-facing.
  walk(subtree, (node) => {
    if (main && privateMainLiteral(node, file)) {
      return
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      hits.push(...hit(file, node, node.text))
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent
      // Object/schema keys include unquoted and shorthand names, not local variable names.
      if (
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent)) &&
          parent.name === node) ||
        ts.isShorthandPropertyAssignment(parent)
      ) {
        hits.push(...hit(file, node, node.text))
      }
    }
  })
  return hits
}

describe('session ledger public vocabulary', () => {
  it('keeps the entire shared contract and preload implementation free of private vocabulary', () => {
    const hits = [
      'src/shared/session-ledger-contract.ts',
      'src/preload/api/session-ledger-api.ts'
    ].flatMap((path) =>
      source(path)
        .text.split('\n')
        .flatMap((line, index) =>
          forbidden.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []
        )
    )
    expect(hits).toEqual([])
  })

  it('checks the sessionLedger preload member and its contract import without unrelated APIs', () => {
    const file = source('src/preload/api-types.ts')
    const sections: ts.Node[] = []
    walk(file, (node) => {
      if (ts.isPropertySignature(node) && node.name.getText(file) === 'sessionLedger') {
        sections.push(node)
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '../shared/session-ledger-contract'
      ) {
        sections.push(node)
      }
    })
    expect(sections).toHaveLength(2)
    expect(sections.flatMap((node) => hit(file, node, node.getText(file)))).toEqual([])
  })

  it('checks ledger field names, event literals, and caller errors throughout the main tier', () => {
    const files = productionFiles('src/main/session-ledger')
    expect(files.length).toBeGreaterThan(0)
    // Queue/spill/identity literals feed publication too; do not restrict this to client.ts.
    expect(files.flatMap((path) => literalHits(source(path), undefined, true))).toEqual([])
  })

  it('checks every sidebar string, template fragment, and JSX text', () => {
    const files = productionFiles(sidebar)
    expect(files.length).toBeGreaterThan(0)
    expect(files.flatMap((path) => literalHits(source(path)))).toEqual([])
  })

  it('checks every English key and value in the namespaces used by sidebar translate calls', () => {
    const namespaces = new Set<string>()
    for (const path of productionFiles(sidebar)) {
      const file = source(path)
      walk(file, (node) => {
        if (!ts.isCallExpression(node) || node.expression.getText(file) !== 'translate') {
          return
        }
        const key = node.arguments[0]
        // Dynamic translation keys must be made explicit so namespace coverage cannot disappear.
        expect(key && ts.isStringLiteralLike(key), `${path}: static translate key required`).toBe(
          true
        )
        if (key && ts.isStringLiteralLike(key)) {
          namespaces.add(key.text.split('.')[0]!)
        }
      })
    }
    expect(namespaces.size).toBeGreaterThan(0)
    const file = source('src/renderer/src/i18n/locales/en.json')
    const statement = file.statements[0]
    expect(statement && ts.isExpressionStatement(statement)).toBe(true)
    if (
      !statement ||
      !ts.isExpressionStatement(statement) ||
      !ts.isObjectLiteralExpression(statement.expression)
    ) {
      throw new Error('Expected locale object')
    }
    const hits: string[] = []
    for (const namespace of namespaces) {
      const section = statement.expression.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.name) &&
          property.name.text === namespace
      )
      expect(section, `Missing English namespace: ${namespace}`).toBeDefined()
      if (section) {
        hits.push(...literalHits(file, section))
      }
    }
    expect(hits).toEqual([])
  })
})
