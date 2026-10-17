import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

/**
 * Why: Zustand's `useShallow` compares the selected value ONE level deep. A fresh `[]`, `{}`,
 * `.map(...)` result or literal that sits one level below the returned value (e.g.
 * `{ tabs: state.tabs ?? [] }`) is a new reference on every read, so React sees a new
 * snapshot each time and re-renders forever (React #185; the Attention page shipped that
 * loop in 1.9.3). Nested fallbacks must be module-level `EMPTY_*` constants.
 *
 * A fresh TOP-LEVEL array or object whose members are stable references or primitives is
 * exactly what `useShallow` exists for (it compares iterables element-wise), so `return []`
 * or `.map((t) => t.id)` at the top level is allowed — unless the mapped elements are
 * themselves fresh object literals. Opt out of a justified line with
 * `// useShallow-fresh-ref-ok: <reason>` on that line or the line above.
 */

export const OPT_OUT_MARKER = 'useShallow-fresh-ref-ok:'
const SOURCE_ROOT = 'src'
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out'])

const NESTED_PATTERNS = [
  { rule: 'nested-fallback-empty-array', regex: /\?\?\s*\[\s*\]/ },
  { rule: 'nested-fallback-empty-object', regex: /\?\?\s*\{\s*\}/ },
  { rule: 'nested-map-call', regex: /\.map\s*\(/ },
  { rule: 'nested-filter-call', regex: /\.filter\s*\(/ },
  { rule: 'nested-object-values', regex: /\bObject\.(?:values|keys|entries)\s*\(/ },
  // Why: `(?<!\?)` keeps `?? []` on the fallback rule instead of double-reporting it as a literal.
  { rule: 'nested-array-literal', regex: /(?:^|(?<!\?)[:?,(=]\s*)\[/ },
  { rule: 'nested-object-literal', regex: /(?:^|(?<!\?)[:?,(=]\s*)\{/ }
]
const PROPERTY_LINE = /^\s*(?:[\w$]+|'[^']*'|"[^"]*"|\[[^\]]+\])\s*:(?!:)\s*(.*)$/
const RETURN_OBJECT = /(?:=>\s*\(\s*\{|\breturn\s*\{)\s*(.*)$/
const FRESH_ELEMENT_MAP = /\.(?:map|flatMap)\s*\(.*?=>\s*\(?\s*\{/

function findMatchingParen(source, openIndex) {
  let depth = 0
  let quote = null
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

/** Every `useShallow(` callback body with its starting line number. */
export function extractUseShallowCallbacks(source) {
  const callbacks = []
  const marker = /\buseShallow\s*\(/g
  let match
  while ((match = marker.exec(source)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findMatchingParen(source, openIndex)
    if (closeIndex === -1) {
      break
    }
    callbacks.push({
      body: source.slice(openIndex + 1, closeIndex),
      line: source.slice(0, openIndex).split('\n').length
    })
    marker.lastIndex = closeIndex
  }
  return callbacks
}

function stripComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
}

function hasOptOut(lines, index) {
  return (
    lines[index].includes(OPT_OUT_MARKER) ||
    (index > 0 && lines[index - 1].includes(OPT_OUT_MARKER))
  )
}

// Why: `[state.a, state.b]` at the top level is fine — shallow compares iterables
// element-wise — but `[{ ... }]` or `[state.list.map(...)]` still yields fresh elements.
export function isPrimitiveOnlyArrayLiteral(literal) {
  const inner = literal.trim().slice(1, -1).trim()
  if (inner.length === 0) {
    return true
  }
  return inner
    .split(',')
    .map((part) => part.trim())
    .every((part) =>
      /^[A-Za-z_$][\w$.?!]*$|^-?\d+(\.\d+)?$|^'[^']*'$|^"[^"]*"$|^(true|false|null|undefined)$/.test(
        part
      )
    )
}

function nestedFindings(valueText) {
  if (/\?\?\s*EMPTY_[A-Z0-9_]+/.test(valueText) && !/\?\?\s*(?:\[\s*\]|\{\s*\})/.test(valueText)) {
    return NESTED_PATTERNS.filter(
      (pattern) => pattern.rule.endsWith('-call') && pattern.regex.test(valueText)
    ).map((pattern) => pattern.rule)
  }
  return NESTED_PATTERNS.filter((pattern) => pattern.regex.test(valueText)).map(
    (pattern) => pattern.rule
  )
}

function topLevelFindings(lineText) {
  const findings = []
  if (FRESH_ELEMENT_MAP.test(lineText)) {
    findings.push('map-with-fresh-object-elements')
  }
  const arrayLiteral = lineText.match(/(?:^\s*|=>\s*|\breturn\s*)(\[[^\]]*\])/)
  if (arrayLiteral && !isPrimitiveOnlyArrayLiteral(arrayLiteral[1])) {
    findings.push('array-literal-with-fresh-elements')
  }
  return findings
}

/** Findings for one file's source text: `{ line, rule, text }`. */
export function scanSourceForFreshReferences(source) {
  const findings = []
  for (const callback of extractUseShallowCallbacks(source)) {
    const lines = callback.body.split('\n')
    let inNestedValue = false
    lines.forEach((rawLine, offset) => {
      const line = stripComments(rawLine)
      const lineNumber = callback.line + offset
      const property = line.match(PROPERTY_LINE)
      const returnObject = line.match(RETURN_OBJECT)
      let rules = []
      if (FRESH_ELEMENT_MAP.test(line)) {
        inNestedValue = false
        rules = topLevelFindings(line)
      } else if (returnObject && returnObject[1].trim().length > 0) {
        rules = nestedFindings(returnObject[1])
      } else if (property) {
        rules = nestedFindings(property[1])
        inNestedValue = !/,\s*$/.test(line)
      } else if (inNestedValue && /^\s*[.?:]/.test(line)) {
        rules = nestedFindings(line)
        inNestedValue = !/,\s*$/.test(line)
      } else {
        inNestedValue = false
        rules = topLevelFindings(line)
      }
      if (rules.length > 0 && !hasOptOut(lines, offset)) {
        for (const rule of rules) {
          findings.push({ line: lineNumber, rule, text: rawLine.trim() })
        }
      }
    })
  }
  return findings
}

async function collectSourceFiles(dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await collectSourceFiles(full, files)
      }
    } else if (
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(full)
    }
  }
  return files
}

/** Scan the repo; returns `{ files, findings }` where findings carry relative paths. */
export async function scanRepoForFreshReferences(root = process.cwd()) {
  const files = await collectSourceFiles(path.join(root, SOURCE_ROOT))
  const findings = []
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    if (!source.includes('useShallow(')) {
      continue
    }
    for (const finding of scanSourceForFreshReferences(source)) {
      findings.push({ ...finding, file: path.relative(root, file) })
    }
  }
  return { files: files.length, findings }
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`
}

export async function main(root = process.cwd()) {
  const { files, findings } = await scanRepoForFreshReferences(root)
  if (findings.length > 0) {
    console.error(
      `useShallow fresh-reference check failed with ${findings.length} finding(s) ` +
        `(reuse a module-level EMPTY_* constant, or add \`// ${OPT_OUT_MARKER} <reason>\`):`
    )
    for (const finding of findings) {
      console.error(`- ${formatFinding(finding)}`)
    }
    return 1
  }
  console.log(`useShallow fresh-reference check passed for ${files} source file(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
