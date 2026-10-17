import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every change to how sessions are organized goes through the recorded change path
 * (docs/reference/session-organization-change-path.md), so the move log is complete. This fails
 * when a file outside the path calls a folder, view, hidden-list, snooze or tag store mutator
 * directly.
 *
 * The allowlist only shrinks: each entry is part of the path, or records its changes elsewhere.
 */
const ALLOWED: Record<string, string> = {
  'src/renderer/src/lib/session-organization-values.ts': 'the change path’s applier',
  'src/renderer/src/lib/session-organization-app-changes.ts':
    'the change path’s store actions for app and launch changes',
  'src/renderer/src/lib/session-organization-person-changes.ts':
    'a person’s folder create/delete, recorded right after',
  'src/renderer/src/lib/session-folder-cli-apply.ts': 'CLI ops main prepared and settles',
  'src/renderer/src/lib/session-folder-cli-folder-ops.ts': 'CLI ops main prepared and settles',
  'src/renderer/src/lib/session-folder-cli-session-ops.ts': 'CLI ops main prepared and settles',
  'src/renderer/src/lib/session-folder-cli-undo.ts':
    'the folder-tree snapshot Undo, recorded by session-folder-cli-toast-undo',
  'src/renderer/src/lib/account-sync/session-sync-engine.ts': 'account sync (WP-B records it)',
  'src/renderer/src/hooks/use-session-account-sync.ts': 'account sync (WP-B records it)',
  'src/renderer/src/lib/session-organization-key-migration.ts': 'key migration (WP-B records it)',
  'src/renderer/src/components/sidebar/routines/routine-sidebar-stores.ts':
    'the one-time carry-over of the old Routines tab',
  'src/renderer/src/lib/session-organization-view-values.ts':
    'the change path’s tag, hide and snooze applier',
  'src/renderer/src/components/sidebar/session-folders/sidebar-group-and-routine-hiding.ts':
    'hides a whole group or a routine, which no change kind names',
  'src/renderer/src/components/next-step/next-step-actions.ts':
    'brings back pane, card and thread waits; a session row’s goes through the path',
  'src/renderer/src/lib/session-snooze.ts': 'retires the old per-view snooze once',
  'src/renderer/src/components/settings/SessionTagsPane.tsx':
    'edits tag names and colors, not which sessions have them'
}

/** The store files that define the mutators. */
const STORE_FILES = new Set([
  'src/renderer/src/store/session-folders.ts',
  'src/renderer/src/store/session-sidebar-view.ts',
  'src/renderer/src/store/session-tags.ts',
  'src/renderer/src/store/wait-later-store.ts'
])

const MUTATORS = [
  'createFolder',
  'renameFolder',
  'deleteFolder',
  'moveFolder',
  'moveSession',
  'moveSessions',
  'moveSessionDurably',
  'saveSession',
  'finishForMe',
  'setArchived',
  'archiveTransfer',
  'archiveVerified',
  'setDeleted',
  'setGroupColor',
  'replaceMetadata',
  'setProjectSettings',
  'setHidden',
  'setHiddenMany',
  'snooze',
  'setUntil'
]

// Why the lookahead: a call, or the method passed along; never a translation key like 'x.createFolder'.
const DIRECT_CALL = new RegExp(`\\.(?:${MUTATORS.join('|')})(?=\\s*[(),;}\\]]|\\s*$)`, 'm')

// Why import-scoped: `save` is too common a name to flag everywhere; the tag store's is the one.
const TAG_STORE_IMPORT = /from '@\/store\/session-tags'/
const TAG_MUTATION = /\.(?:save|migrateSessionKey)(?=\s*[(),;}\]]|\s*$)/m

function mutatesDirectly(code: string): boolean {
  return DIRECT_CALL.test(code) || (TAG_STORE_IMPORT.test(code) && TAG_MUTATION.test(code))
}

function collect(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collect(full))
    } else if (/\.tsx?$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('session organization change path boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..', '..')
  const files = collect(join(repoRoot, 'src/renderer/src')).map((file) =>
    relative(repoRoot, file).split('\\').join('/')
  )
  const offenders = files
    .filter((path) => !STORE_FILES.has(path))
    .filter((path) => mutatesDirectly(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it('scans the renderer', () => {
    // A wrong root would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain('src/renderer/src/store/session-folders.ts')
  })

  it('finds a direct call when one is written', () => {
    expect(DIRECT_CALL.test('useSessionSidebarView.getState().setArchived([key], true)')).toBe(true)
    expect(DIRECT_CALL.test('onMoveSessionKey: folders.moveSession,')).toBe(true)
    expect(DIRECT_CALL.test("translate('chatActions.createFolder', 'Create Folder')")).toBe(false)
    expect(DIRECT_CALL.test('view.setHidden(`conversation:${key}`, true)')).toBe(true)
    expect(DIRECT_CALL.test('useWaitLater.getState().setUntil(key, null)')).toBe(true)
    const tagImport = "import { useSessionTags } from '@/store/session-tags'\n"
    expect(mutatesDirectly(`${tagImport}store.save({ ...store.data, assignments })`)).toBe(true)
    expect(mutatesDirectly(`${tagImport}store.setFilter([])`)).toBe(false)
    expect(mutatesDirectly('settingsStore.save(next)')).toBe(false)
  })

  it('has no direct store mutation outside the change path', () => {
    const unlisted = offenders.filter((path) => !(path in ALLOWED))
    expect(
      unlisted,
      'Direct session folder/view store mutation. Use applyOrganizationChange (or a helper in session-organization-person-changes / -app-changes) so the change is recorded.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const stale = Object.keys(ALLOWED).filter((path) => !offenders.includes(path))
    expect(stale, 'Allowlist entry no longer mutates the stores directly: delete it.').toEqual([])
  })
})
