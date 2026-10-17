import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveSessionFilePath } from './session-file-resolver'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['pi', 'prime-agent'] as const)(
  'resolves %s without crossing family roots',
  async (agent) => {
    const root = await mkdtemp(join(tmpdir(), 'chat-pi-roots-'))
    roots.push(root)
    const options = {
      piSessionsDir: join(root, 'pi'),
      primeAgentSessionsDir: join(root, 'prime'),
      ompSessionsDir: join(root, 'omp')
    }
    const targetRoot = agent === 'pi' ? options.piSessionsDir : options.primeAgentSessionsDir
    for (const dir of Object.values(options)) {
      await mkdir(join(dir, '--workspace--'), { recursive: true })
      await writeFile(join(dir, '--workspace--', 'stamp_same-id.jsonl'), '{}\n')
    }
    expect(await resolveSessionFilePath(agent, 'same-id', options)).toBe(
      join(targetRoot, '--workspace--', 'stamp_same-id.jsonl')
    )
    await writeFile(join(options.ompSessionsDir, 'only-omp.jsonl'), '{}\n')
    expect(await resolveSessionFilePath(agent, 'only-omp', options)).toBeNull()
    await writeFile(join(targetRoot, 'flat-id.jsonl'), '{}\n')
    expect(await resolveSessionFilePath(agent, 'flat-id', options)).toBe(
      join(targetRoot, 'flat-id.jsonl')
    )
    // Artifact pruning recognizes the session's ISO timestamp and UUID, not a literal 'stamp'.
    const artifacts = join(
      targetRoot,
      '--workspace--',
      '2026-09-15T12-00-00-000Z_019fd8e2-fd56-7000-acfe-2e497adfa83c'
    )
    await mkdir(artifacts)
    await writeFile(join(artifacts, 'worker_child-id.jsonl'), '{}\n')
    expect(await resolveSessionFilePath(agent, 'child-id', options)).toBeNull()
    const exact = join(root, 'reported.jsonl')
    await writeFile(exact, '{}\n')
    expect(
      await resolveSessionFilePath(agent, 'same-id', { ...options, transcriptPath: exact })
    ).toBe(exact)
  }
)

it.each([
  ['pi', 'PI_CODING_AGENT_DIR'],
  ['prime-agent', 'PRIME_AGENT_CODING_AGENT_DIR']
] as const)('honors %s agent-directory overrides', async (agent, envKey) => {
  const root = await mkdtemp(join(tmpdir(), 'chat-pi-env-'))
  roots.push(root)
  vi.stubEnv('PRIME_AGENT_SESSION_DIR', '')
  vi.stubEnv('PRIME_AGENT_CODING_AGENT_SESSION_DIR', '')
  vi.stubEnv(envKey, join(root, 'agent'))
  await mkdir(join(root, 'agent', 'sessions'), { recursive: true })
  const target = join(root, 'agent', 'sessions', 'env-id.jsonl')
  await writeFile(target, '{}\n')
  expect(await resolveSessionFilePath(agent, 'env-id')).toBe(target)
})
