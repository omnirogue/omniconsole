import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SessionHostRelocationManifestSchema,
  sessionHostRelocationManifestDigest
} from '../../shared/session-host-payload-schema'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import { selectClaudeResumeIdentity } from '../claude/claude-resume-identity'
import { SessionRelocationRefusal } from './relocation-bundle-files'
import { exportRelocationBundle, importRelocationBundle } from './relocation-bundle-import'

const CLAUDE_ID = '5b1f0c1e-7d7c-4c0e-9a55-0f1f2e3d4c5b'
const CODEX_ID = '01a0a697-11e7-7cc0-9e21-eb1844eb3128'
const SECRET = 'fake-credential-THIS-MUST-NEVER-TRAVEL'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relocation-bundle-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

function claudeLines(id: string, turns: number): string {
  const lines = [{ type: 'mode', mode: 'default', sessionId: id }]
  for (let n = 1; n <= turns; n += 1) {
    lines.push({ type: 'user', message: `turn ${n}`, sessionId: id } as never)
    lines.push({ type: 'assistant', message: `reply ${n}`, sessionId: id } as never)
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

/** A Claude account home on the "source computer", with its credentials beside the transcript. */
function claudeSource(): { configDir: string; transcriptPath: string } {
  const configDir = join(root, 'source', '.claude-account-2')
  write(join(configDir, '.credentials.json'), JSON.stringify({ token: SECRET }))
  write(join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: SECRET }))
  const folder = join(configDir, 'projects', encodeClaudeProjectPath('/Users/maintainer/work/app'))
  const transcriptPath = write(join(folder, `${CLAUDE_ID}.jsonl`), claudeLines(CLAUDE_ID, 40))
  write(join(folder, CLAUDE_ID, 'subagents', 'agent-1.jsonl'), claudeLines(CLAUDE_ID, 2))
  write(join(folder, CLAUDE_ID, 'tool-results', 'toolu_1.txt'), 'long tool output\n')
  write(join(folder, 'other-session.jsonl'), claudeLines('other-session', 1))
  return { configDir, transcriptPath }
}

function codexSource(): { home: string; transcriptPath: string } {
  const home = join(root, 'source', '.codex')
  write(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: SECRET }))
  const lines = [
    { type: 'session_meta', payload: { id: CODEX_ID, session_id: CODEX_ID, cwd: '/w' } },
    { type: 'response_item', payload: { text: 'hello' } },
    { type: 'response_item', payload: { text: 'world' } }
  ]
  const transcriptPath = write(
    join(home, 'sessions', '2026', '09', '15', `rollout-2026-09-15T15-41-53-${CODEX_ID}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  )
  return { home, transcriptPath }
}

/** What the orchestrator's channel does: each manifest file copied into the destination's staging. */
function stageCopy(files: ReadonlyMap<string, string>): string {
  const staging = join(root, 'destination', 'staging')
  for (const [path, absolute] of files) {
    const to = join(staging, ...path.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    cpSync(absolute, to)
  }
  return staging
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(SessionRelocationRefusal)
  return (error as SessionRelocationRefusal).refusal.code
}

describe('Claude relocation bundle', () => {
  it('moves the transcript and its artifacts, resumes the identical id with complete history', async () => {
    const source = claudeSource()
    const bundle = await exportRelocationBundle('claude', {
      sessionId: CLAUDE_ID,
      transcriptPath: source.transcriptPath
    })
    expect(SessionHostRelocationManifestSchema.parse(bundle.manifest)).toEqual(bundle.manifest)
    expect(bundle.manifest.files.map((file) => file.path).sort()).toEqual([
      `${CLAUDE_ID}.jsonl`,
      `${CLAUDE_ID}/subagents/agent-1.jsonl`,
      `${CLAUDE_ID}/tool-results/toolu_1.txt`
    ])
    // Why: the manifest is paths and digests only; no credential, home or account path travels.
    const serialized = JSON.stringify(bundle.manifest)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('credentials')
    expect(serialized).not.toContain(root)

    const destinationHome = join(root, 'destination', '.claude')
    const place = { providerRoot: destinationHome, workspacePath: '/home/sal/checkouts/app' }
    const staged = await importRelocationBundle({
      stagingRoot: stageCopy(bundle.files),
      manifest: bundle.manifest,
      place,
      providerVersion: null
    })
    const expectedTranscript = join(
      destinationHome,
      'projects',
      encodeClaudeProjectPath(place.workspacePath),
      `${CLAUDE_ID}.jsonl`
    )
    expect(staged.identity).toEqual({
      agent: 'claude',
      sessionId: CLAUDE_ID,
      transcriptPath: expectedTranscript,
      providerRoot: destinationHome
    })
    expect(readFileSync(expectedTranscript, 'utf8')).toBe(
      readFileSync(source.transcriptPath, 'utf8')
    )
    expect(readFileSync(expectedTranscript, 'utf8').split('\n').filter(Boolean)).toHaveLength(81)
    expect(
      selectClaudeResumeIdentity({
        key: 'session_id',
        id: CLAUDE_ID,
        transcriptPath: expectedTranscript
      })
    ).toEqual({ key: 'session_id', id: CLAUDE_ID, transcriptPath: expectedTranscript })

    // Staging the same bundle again is harmless; nothing is overwritten or duplicated.
    const again = await importRelocationBundle({
      stagingRoot: join(root, 'destination', 'staging'),
      manifest: bundle.manifest,
      place,
      providerVersion: null
    })
    expect(again.identity).toEqual(staged.identity)
  })

  it('refuses a credential file or a symlink inside the conversation folder', async () => {
    const source = claudeSource()
    const folder = dirname(source.transcriptPath)
    write(join(folder, CLAUDE_ID, 'auth.json'), JSON.stringify({ key: SECRET }))
    expect(
      await refusal(
        exportRelocationBundle('claude', {
          sessionId: CLAUDE_ID,
          transcriptPath: source.transcriptPath
        })
      )
    ).toBe('not-eligible')
    rmSync(join(folder, CLAUDE_ID, 'auth.json'))
    symlinkSync(join(source.configDir, '.credentials.json'), join(folder, CLAUDE_ID, 'linked.txt'))
    expect(
      await refusal(
        exportRelocationBundle('claude', {
          sessionId: CLAUDE_ID,
          transcriptPath: source.transcriptPath
        })
      )
    ).toBe('not-eligible')
  })

  it('refuses a transcript the provider may still be writing', async () => {
    const source = claudeSource()
    writeFileSync(source.transcriptPath, `${claudeLines(CLAUDE_ID, 1)}{"type":"assistant","mess`)
    expect(
      await refusal(
        exportRelocationBundle('claude', {
          sessionId: CLAUDE_ID,
          transcriptPath: source.transcriptPath
        })
      )
    ).toBe('not-eligible')
  })

  it('refuses a transcript written by a newer provider than the destination has', async () => {
    const source = claudeSource()
    const newer = claudeLines(CLAUDE_ID, 2).replaceAll(
      '"sessionId"',
      '"version":"2.3.0","sessionId"'
    )
    writeFileSync(source.transcriptPath, newer)
    const bundle = await exportRelocationBundle('claude', {
      sessionId: CLAUDE_ID,
      transcriptPath: source.transcriptPath
    })
    const place = { providerRoot: join(root, 'destination', '.claude'), workspacePath: '/w' }
    const staging = stageCopy(bundle.files)
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: staging,
          manifest: bundle.manifest,
          place,
          providerVersion: '2.2.9'
        })
      )
    ).toBe('not-eligible')
    // Nothing was filed into the destination's home.
    expect(existsSync(join(place.providerRoot, 'projects'))).toBe(false)
    const staged = await importRelocationBundle({
      stagingRoot: staging,
      manifest: bundle.manifest,
      place,
      providerVersion: '2.3.1'
    })
    expect(staged.writerVersion).toBe('2.3.0')
  })

  it('never overwrites a different conversation file already at the destination', async () => {
    const source = claudeSource()
    const bundle = await exportRelocationBundle('claude', {
      sessionId: CLAUDE_ID,
      transcriptPath: source.transcriptPath
    })
    const place = { providerRoot: join(root, 'destination', '.claude'), workspacePath: '/w' }
    const occupied = write(
      join(place.providerRoot, 'projects', encodeClaudeProjectPath('/w'), `${CLAUDE_ID}.jsonl`),
      claudeLines(CLAUDE_ID, 1)
    )
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: stageCopy(bundle.files),
          manifest: bundle.manifest,
          place,
          providerVersion: null
        })
      )
    ).toBe('ownership-conflict')
    expect(readFileSync(occupied, 'utf8')).toBe(claudeLines(CLAUDE_ID, 1))
  })
})

describe('Codex relocation bundle', () => {
  it('moves the dated rollout and resumes it under the destination home only', async () => {
    const source = codexSource()
    const bundle = await exportRelocationBundle('codex', {
      sessionId: CODEX_ID,
      transcriptPath: source.transcriptPath
    })
    expect(bundle.manifest.files.map((file) => file.path)).toEqual([
      `sessions/2026/09/15/rollout-2026-09-15T15-41-53-${CODEX_ID}.jsonl`
    ])
    expect(JSON.stringify(bundle.manifest)).not.toContain(SECRET)
    const place = { providerRoot: join(root, 'destination', '.codex-work'), workspacePath: '/w' }
    const staged = await importRelocationBundle({
      stagingRoot: stageCopy(bundle.files),
      manifest: bundle.manifest,
      place,
      providerVersion: null
    })
    expect(staged.identity).toEqual({
      agent: 'codex',
      sessionId: CODEX_ID,
      transcriptPath: join(place.providerRoot, ...bundle.manifest.files[0]!.path.split('/')),
      providerRoot: place.providerRoot
    })
    expect(readFileSync(staged.identity.transcriptPath, 'utf8')).toBe(
      readFileSync(source.transcriptPath, 'utf8')
    )
  })

  it('refuses a compressed rollout and a rollout whose first record is not its session', async () => {
    const source = codexSource()
    expect(
      await refusal(
        exportRelocationBundle('codex', {
          sessionId: CODEX_ID,
          transcriptPath: `${source.transcriptPath}.zst`
        })
      )
    ).toBe('unsupported-capability')
    writeFileSync(source.transcriptPath, `${JSON.stringify({ type: 'response_item' })}\n`)
    expect(
      await refusal(
        exportRelocationBundle('codex', {
          sessionId: CODEX_ID,
          transcriptPath: source.transcriptPath
        })
      )
    ).toBe('unsupported-capability')
  })
})

describe('staging checks the bundle against its manifest', () => {
  async function exported() {
    const source = claudeSource()
    return await exportRelocationBundle('claude', {
      sessionId: CLAUDE_ID,
      transcriptPath: source.transcriptPath
    })
  }
  const place = () => ({ providerRoot: join(root, 'destination', '.claude'), workspacePath: '/w' })

  it('refuses a changed, missing or extra file, and a manifest that names files outside it', async () => {
    const bundle = await exported()
    const staging = stageCopy(bundle.files)
    writeFileSync(join(staging, `${CLAUDE_ID}.jsonl`), claudeLines(CLAUDE_ID, 2))
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: staging,
          manifest: bundle.manifest,
          place: place(),
          providerVersion: null
        })
      )
    ).toBe('not-eligible')

    rmSync(staging, { recursive: true })
    stageCopy(bundle.files)
    write(join(staging, 'settings.json'), JSON.stringify({ apiKeyHelper: SECRET }))
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: staging,
          manifest: bundle.manifest,
          place: place(),
          providerVersion: null
        })
      )
    ).toBe('not-eligible')

    const extra = { ...bundle.manifest.files[0]!, path: 'notes/extra.jsonl' }
    const unsigned = { ...bundle.manifest, files: [...bundle.manifest.files, extra] }
    const outsideLayout = { ...unsigned, digest: sessionHostRelocationManifestDigest(unsigned) }
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: staging,
          manifest: outsideLayout,
          place: place(),
          providerVersion: null
        })
      )
    ).toBe('invalid-request')
    // A manifest whose digest does not cover its files is refused before any file is read.
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: staging,
          manifest: { ...unsigned, digest: bundle.manifest.digest },
          place: place(),
          providerVersion: null
        })
      )
    ).toBe('invalid-request')
    const credential = {
      ...unsigned,
      files: [...bundle.manifest.files, { ...extra, path: `${CLAUDE_ID}/.credentials.json` }]
    }
    expect(
      await refusal(
        importRelocationBundle({
          stagingRoot: staging,
          manifest: { ...credential, digest: sessionHostRelocationManifestDigest(credential) },
          place: place(),
          providerVersion: null
        })
      )
    ).toBe('not-eligible')
  })
})
