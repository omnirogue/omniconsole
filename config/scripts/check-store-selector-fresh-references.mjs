import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
/**
 * Why: a plain Zustand selector — `useAppStore((s) => ({ a: s.a }))`, `(s) => s.list ?? []`,
 * `(s) => s.items.filter(...)` — is compared with Object.is. A value that is a NEW reference on
 * every read makes React see a new snapshot each time and re-render forever (React #185, the
 * same loop the useShallow gate exists for). That gate only reads `useShallow(` callbacks, so
 * a selector that never used useShallow was invisible to it (Sal, 2026-09-12). This pass reads
 * every `use*Store(` selector that is NOT wrapped in useShallow and refuses a fresh top-level
 * reference. Fix: wrap in `useShallow`, select the stable parent, or return a module-level
 * `EMPTY_*` constant. Opt out of a justified selector with
 * `// store-selector-fresh-ref-ok: <reason>` on the selector's line or the line above.
 */
export const OPT_OUT_MARKER = 'store-selector-fresh-ref-ok:'
const SOURCE_ROOT = 'src'
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out'])

// A result consumed down to a primitive or an existing element is not a fresh reference.
const PRIMITIVE_CONSUMER =
  /\.(?:length|size)\b|\.(?:some|every|includes|has|find|findIndex|findLast|indexOf|join|at|get)\s*\(|===|!==|==|!=|>=|<=|\s[<>]\s|\btypeof\b|\b(?:Boolean|String|Number|JSON\.stringify)\s*\(|^\s*!/
// The value the selector hands back is minted on this read.
// Evaluated on the top-level skeleton: nested groups read as `(…)`, `[…]`, `{…}`.
const FRESH_TAIL =
  /\.(?:map|filter|slice|concat|flat|flatMap|sort|toSorted|reverse|toReversed|splice|with)\s*\(…\)\s*$|^(?:Object\.(?:values|keys|entries|fromEntries|assign)|Array\.from|structuredClone)\s*\(…\)\s*$|^new\s+(?:Set|Map|Array|Date)\b/
const FRESH_FALLBACK = /\?\?\s*(?:\[…\]|\{…\})|\?\s*(?:\[…\]|\{…\})\s*:|:\s*(?:\[…\]|\{…\})\s*$/

function findMatchingParen(source, openIndex) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === '\\') {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }
  return -1
}

function stripComments(text) {
  return text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[^]*?\*\//g, '')
}

function stripOuterParens(text) {
  let value = text.trim()
  while (value.startsWith('(') && findMatchingParen(value, 0) === value.length - 1) {
    value = value.slice(1, -1).trim()
  }
  return value
}

/** The first top-level argument of a call body (text between the call's parens). */
function firstArgument(argsText) {
  let depth = 0
  let quote = null
  for (let i = 0; i < argsText.length; i += 1) {
    const char = argsText[i]
    if (quote) {
      if (char === '\\') {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if ('([{'.includes(char)) {
      depth += 1
    } else if (')]}'.includes(char)) {
      depth -= 1
    } else if (char === ',' && depth === 0) {
      return argsText.slice(0, i)
    }
  }
  return argsText
}

/** Every `use*Store(` selector callback that is not wrapped in `useShallow(`. */
export function extractPlainStoreSelectors(source) {
  const selectors = []
  const marker = /\buse[A-Z]\w*Store\s*\(/g
  let match
  while ((match = marker.exec(source)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findMatchingParen(source, openIndex)
    if (closeIndex === -1) {
      break
    }
    marker.lastIndex = closeIndex
    const argument = stripComments(firstArgument(source.slice(openIndex + 1, closeIndex))).trim()
    if (!argument || /^useShallow\s*\(/.test(argument) || !/=>/.test(argument)) {
      continue
    }
    const arrow = argument.match(/^(?:\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>\s*([^]*)$/)
    if (!arrow) {
      continue
    }
    selectors.push({
      body: arrow[1].trim(),
      line: source.slice(0, match.index).split('\n').length,
      text: source
        .slice(match.index, closeIndex + 1)
        .split('\n')[0]
        .trim()
    })
  }
  return selectors
}

/** The expressions a selector body hands back: the expression itself, or each `return`. */
export function returnedExpressions(body) {
  const value = stripOuterParens(body)
  if (!value.startsWith('{') || findMatchingParen(value, 0) !== value.length - 1) {
    return [value]
  }
  // Why: `({ a: s.a })` is an object literal; `{ const x = …; return x }` is a block.
  const inner = value.slice(1, -1)
  if (!/\breturn\b/.test(inner)) {
    return [value]
  }
  const expressions = []
  const keyword = /\breturn\s+/g
  let match
  while ((match = keyword.exec(inner)) !== null) {
    // Why: the expression ends at the first `;` or `}` outside its own groups.
    let depth = 0
    let end = inner.length
    for (let i = match.index + match[0].length; i < inner.length; i += 1) {
      const char = inner[i]
      if ('([{'.includes(char)) {
        depth += 1
      } else if (')]}'.includes(char)) {
        if (depth === 0) {
          end = i
          break
        }
        depth -= 1
      } else if (char === ';' && depth === 0) {
        end = i
        break
      }
    }
    expressions.push(stripOuterParens(inner.slice(match.index + match[0].length, end)))
    keyword.lastIndex = end
  }
  return expressions
}

/** The expression with every nested group collapsed to `(…)`, `[…]` or `{…}`, so a
 *  `?? []` buried inside a call's arguments does not read as the selector's own result. */
export function topLevelSkeleton(expression) {
  let out = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i]
    if (quote) {
      if (char === '\\') {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if ('([{'.includes(char)) {
      if (depth === 0) {
        out += `${char}…`
      }
      depth += 1
    } else if (')]}'.includes(char)) {
      depth -= 1
      if (depth === 0) {
        out += char
      }
    } else if (depth === 0) {
      out += char
    }
  }
  return out
}

/** Rules a returned expression breaks; empty when the reference is stable or primitive. */
export function freshReferenceRules(expression) {
  const value = stripOuterParens(expression)
  if (!value) {
    return []
  }
  const rules = []
  if (value.startsWith('{')) {
    rules.push('object-literal')
  } else if (value.startsWith('[')) {
    rules.push('array-literal')
  } else {
    const skeleton = topLevelSkeleton(value)
    if (!PRIMITIVE_CONSUMER.test(skeleton)) {
      if (FRESH_FALLBACK.test(skeleton)) {
        rules.push('fresh-fallback')
      }
      if (FRESH_TAIL.test(skeleton)) {
        rules.push('fresh-call-result')
      }
    }
  }
  return rules
}

function hasOptOut(lines, lineNumber) {
  const index = lineNumber - 1
  return (
    lines[index].includes(OPT_OUT_MARKER) ||
    (index > 0 && lines[index - 1].includes(OPT_OUT_MARKER))
  )
}

/** Findings for one file's source text: `{ line, rule, text }`. */
export function scanSourceForPlainSelectorFreshReferences(source) {
  const lines = source.split('\n')
  const findings = []
  for (const selector of extractPlainStoreSelectors(source)) {
    if (hasOptOut(lines, selector.line)) {
      continue
    }
    for (const expression of returnedExpressions(selector.body)) {
      for (const rule of freshReferenceRules(expression)) {
        findings.push({ line: selector.line, rule: `plain-selector-${rule}`, text: selector.text })
      }
    }
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

export async function scanRepoForPlainSelectorFreshReferences(root = process.cwd()) {
  const files = await collectSourceFiles(path.join(root, SOURCE_ROOT))
  const findings = []
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    if (!/\buse[A-Z]\w*Store\s*\(/.test(source)) {
      continue
    }
    for (const finding of scanSourceForPlainSelectorFreshReferences(source)) {
      findings.push({ ...finding, file: path.relative(root, file) })
    }
  }
  return { files: files.length, findings }
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`
}

export async function main(root = process.cwd()) {
  const { files, findings } = await scanRepoForPlainSelectorFreshReferences(root)
  if (findings.length > 0) {
    console.error(
      `store-selector fresh-reference check failed with ${findings.length} finding(s) ` +
        `(wrap the selector in useShallow, select the stable parent, or add \`// ${OPT_OUT_MARKER} <reason>\`):`
    )
    for (const finding of findings) {
      console.error(`- ${formatFinding(finding)}`)
    }
    return 1
  }
  console.log(`store-selector fresh-reference check passed for ${files} source file(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
