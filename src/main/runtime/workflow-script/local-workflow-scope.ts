import { createHash } from 'node:crypto'
import { readdir, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createFleetSourceIo } from '../conversation-fleet-source-io'

export const LOCAL_WORKFLOW_FILE_LIMIT = 32 * 1024
export const LOCAL_WORKFLOW_EVIDENCE_LIMIT = 128 * 1024
export const LOCAL_WORKFLOW_SCOPE_LISTED = 2000
export const LOCAL_WORKFLOW_SCOPE_DEPTH = 12
const MAX_SCANNED = 20_000
const MAX_SELECTED = 64
/** Names shown for an attached folder; its files are read by the agents, not inlined. */
const MAX_FOLDER_ENTRIES = 200
const SKIP_DIRECTORY =
  /^(?:\.git|\.hg|\.svn|node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|__pycache__|target|\.idea|\.vscode)$/i
/**
 * Secret-looking files never enter a picker: dotfiles (.env, .npmrc…), key and certificate
 * stores, and credential/secret/token/password data files. Source files that merely mention auth,
 * token or config (useAuth.ts, token-bucket.ts, vite.config.ts) are ordinary code and are listed.
 */
const SECRET_FILE =
  /(?:^\.|\.env$|\.env\.|\.(?:pem|key|p12|pfx|jks|keystore)$|^id_(?:rsa|dsa|ecdsa|ed25519)|(?:secret|credential|token|password|passwd|private[._-]?key|auth)[^/]*\.(?:json|jsonc|ya?ml|toml|ini|env|conf|cfg|properties|txt|xml|plist)$)/i
/**
 * Files that hold credentials by convention whatever their name says. Attached text is frozen
 * into the run and sent to every provider, so these stay out even though agents with workspace
 * access can still open them read-only. Ordinary source such as settings.py stays listed.
 */
const CREDENTIAL_FILE =
  /^(?:service[-_]?account[^/]*\.json|wp-config\.php|database\.ya?ml|local\.settings\.json|appsettings(?:\.[^/]+)?\.json|kubeconfig[^/]*|[^/]*\.tf(?:vars|state)(?:\.[^/]+)?)$/i
const NOISE_FILE = /(?:\.sqlite3?$|\.db$|\.lock$|\.min\.)/i
const TEXT_EXTENSION =
  /\.(?:txt|md|mdx|rst|adoc|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|gql|proto|vue|svelte|astro)$/i
const TEXT_BASENAME =
  /^(?:README|LICENSE|NOTICE|CHANGELOG|CONTRIBUTING|Makefile|Dockerfile|Gemfile|Rakefile)$/i

/** Folder ids end with '/'; file ids never do. */
export type LocalWorkflowScopeItem = { id: string; label: string; unavailableReason?: string }
export type LocalWorkflowScopeSource = { id: string; label: string; bytes: number; digest: string }
export type LocalWorkflowScopeRefusal = { id: string; reason: string }
export type LocalWorkflowMaterializedScope = {
  evidence: string
  sources: LocalWorkflowScopeSource[]
  refusals: LocalWorkflowScopeRefusal[]
  truncated: boolean
  digest: string
}

function safeId(id: string): boolean {
  const path = typeof id === 'string' && id.endsWith('/') ? id.slice(0, -1) : id
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1024 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  )
}

async function workspaceRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) {
    throw new Error('Host workspace root must be absolute')
  }
  const canonical = await realpath(root)
  if (!(await lstat(canonical)).isDirectory()) {
    throw new Error('Host workspace root is not a folder')
  }
  return canonical
}

/** Dependency, build, cache and dot folders never enter a scope. */
export function localWorkflowDirectorySkipped(name: string): boolean {
  return SKIP_DIRECTORY.test(name) || name.startsWith('.')
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** A file a person may pick (and Quick Discover bundles): text, not a secret, lock or minified. */
export function localWorkflowFileListable(name: string): boolean {
  return (
    !SECRET_FILE.test(name) &&
    !CREDENTIAL_FILE.test(name) &&
    !NOISE_FILE.test(name) &&
    (TEXT_EXTENSION.test(name) || TEXT_BASENAME.test(name))
  )
}

/**
 * Lists folders and eligible text files breadth-first, so every shallow folder stays pickable
 * even in a large repository. Bounded by count, entries scanned and depth; no shell is run.
 */
export async function listLocalWorkflowScope(root: string): Promise<LocalWorkflowScopeItem[]> {
  const canonical = await workspaceRoot(root)
  const listed: LocalWorkflowScopeItem[] = []
  let scanned = 0
  let level: { directory: string; prefix: string }[] = [{ directory: canonical, prefix: '' }]
  for (let depth = 0; depth <= LOCAL_WORKFLOW_SCOPE_DEPTH && level.length; depth++) {
    const next: typeof level = []
    for (const { directory, prefix } of level) {
      if (listed.length >= LOCAL_WORKFLOW_SCOPE_LISTED || scanned >= MAX_SCANNED) {
        break
      }
      if (
        !inside(canonical, directory) ||
        (await realpath(directory)) !== directory ||
        !(await lstat(directory)).isDirectory()
      ) {
        continue
      }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED || listed.length >= LOCAL_WORKFLOW_SCOPE_LISTED) {
          break
        }
        const id = prefix ? `${prefix}/${entry.name}` : entry.name
        if (!safeId(id) || entry.isSymbolicLink()) {
          continue
        }
        if (entry.isDirectory()) {
          if (!localWorkflowDirectorySkipped(entry.name)) {
            listed.push({ id: `${id}/`, label: `${id}/` })
            if (depth < LOCAL_WORKFLOW_SCOPE_DEPTH) {
              next.push({ directory: join(directory, entry.name), prefix: id })
            }
          }
          continue
        }
        if (!entry.isFile() || !localWorkflowFileListable(entry.name)) {
          continue
        }
        try {
          const stat = await lstat(join(directory, entry.name))
          listed.push({
            id,
            label: id,
            ...(stat.size > LOCAL_WORKFLOW_FILE_LIMIT
              ? { unavailableReason: `File exceeds ${LOCAL_WORKFLOW_FILE_LIMIT} bytes` }
              : {})
          })
        } catch {
          listed.push({ id, label: id, unavailableReason: 'File cannot be inspected' })
        }
      }
    }
    level = next
  }
  return listed.sort((a, b) => a.id.localeCompare(b.id))
}

/** "--- path ---" then "  12| code", so answers can cite path:line. */
export function localWorkflowNumberedSource(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') {
    lines.pop()
  }
  const width = Math.max(4, String(lines.length).length)
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join('\n')
}

function folderPart(id: string, listed: readonly LocalWorkflowScopeItem[]): string {
  const files = listed.filter((item) => item.id.startsWith(id) && !item.id.endsWith('/'))
  const shown = files.slice(0, MAX_FOLDER_ENTRIES).map((item) => item.id)
  const more = files.length - shown.length
  return `\n--- ${id} (folder) ---\n${[...shown, ...(more > 0 ? [`… and ${more} more`] : [])].join('\n')}\n`
}

/**
 * Re-lists and opens selected files exactly, with line numbers; a folder contributes its file
 * names. Every refusal is explicit and no bytes are silently truncated.
 */
export async function materializeLocalWorkflowScope(
  root: string,
  scopeIds: readonly string[]
): Promise<LocalWorkflowMaterializedScope> {
  if (
    !Array.isArray(scopeIds) ||
    scopeIds.length > MAX_SELECTED ||
    new Set(scopeIds).size !== scopeIds.length ||
    scopeIds.some((id) => !safeId(id))
  ) {
    throw new Error('Invalid workflow scope selection')
  }
  const canonical = await workspaceRoot(root)
  const listing = await listLocalWorkflowScope(canonical)
  const listed = new Map(listing.map((item) => [item.id, item]))
  const io = createFleetSourceIo()
  const sources: LocalWorkflowScopeSource[] = []
  const refusals: LocalWorkflowScopeRefusal[] = []
  const parts: string[] = []
  let used = 0
  for (const id of scopeIds) {
    const item = listed.get(id)
    if (!item) {
      refusals.push({ id, reason: 'File is not in the current host scope list' })
      continue
    }
    if (item.unavailableReason) {
      refusals.push({ id, reason: item.unavailableReason })
      continue
    }
    const path = join(canonical, ...id.split('/').filter(Boolean))
    try {
      if (!inside(canonical, path) || (await realpath(path)) !== path) {
        throw new Error('File path changed or contains a symlink')
      }
      let part: string
      let bytes: Buffer
      if (id.endsWith('/')) {
        part = folderPart(id, listing)
        bytes = Buffer.from(part)
      } else {
        bytes = await io.readExact(path, LOCAL_WORKFLOW_FILE_LIMIT)
        if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
          throw new Error('File is not UTF-8 text')
        }
        part = `\n--- ${id} ---\n${localWorkflowNumberedSource(bytes.toString('utf8'))}\n`
      }
      const size = Buffer.byteLength(part)
      if (used + size > LOCAL_WORKFLOW_EVIDENCE_LIMIT) {
        throw new Error('Total evidence byte limit exceeded')
      }
      used += size
      parts.push(part)
      sources.push({
        id,
        label: item.label,
        bytes: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex')
      })
    } catch (error) {
      refusals.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const evidence = parts.join('')
  return {
    evidence,
    sources,
    refusals,
    truncated: refusals.length > 0,
    digest: createHash('sha256')
      .update(JSON.stringify({ evidence, sources, refusals }))
      .digest('hex')
  }
}
