import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenRouterWorkspace } from './workflow-openrouter-workspace'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'workflow-openrouter-'))
  directories.push(parent)
  const root = path.join(parent, 'workspace')
  await fs.mkdir(root)
  await fs.writeFile(path.join(parent, 'secret'), 'outside')
  await fs.writeFile(path.join(root, 'hello.txt'), 'one\ntwo\nthree')
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(root, '.git', 'config'), 'hidden')
  return {
    root,
    parent,
    tools: createOpenRouterWorkspace(fs, path, root, Date.now() + 10000, constants)
  }
}
describe('OpenRouter confined workspace', () => {
  it('reads numbered ranges and literal search in a folder without git', async () => {
    const { tools } = await fixture()
    expect(await tools('read_file', { path: 'hello.txt', start_line: 2, end_line: 2 })).toBe(
      '2: two'
    )
    expect(await tools('search', { pattern: 'two' })).toBe('hello.txt:2: two')
    expect(await tools('list_directory', { path: '.' })).toBe('hello.txt')
  })
  it('refuses parent traversal, absolute paths, .git and symlink escapes', async () => {
    const { tools, parent, root } = await fixture()
    await fs.symlink(path.join(parent, 'secret'), path.join(root, 'escape'))
    await fs.symlink(path.join(root, '.git'), path.join(root, 'alias'), 'dir')
    for (const input of [
      '../secret',
      path.join(parent, 'secret'),
      '.git/config',
      'escape',
      'alias/config'
    ]) {
      await expect(tools('read_file', { path: input })).rejects.toThrow('outside')
    }
    await expect(tools('search', { path: '../', pattern: 'outside' })).rejects.toThrow('outside')
    await expect(
      createOpenRouterWorkspace(
        fs,
        path,
        path.join(root, '.git'),
        Date.now() + 10000,
        constants
      )('read_file', { path: 'config' })
    ).rejects.toThrow('outside')
  })
  it('caps reads and search results and observes the deadline', async () => {
    const { tools, root } = await fixture()
    await fs.writeFile(path.join(root, 'large'), 'needle\n'.repeat(100000))
    expect(Buffer.byteLength(await tools('read_file', { path: 'large' }))).toBeLessThanOrEqual(
      200 * 1024
    )
    expect((await tools('search', { pattern: 'needle' })).split('\n')).toHaveLength(200)
    await expect(
      createOpenRouterWorkspace(
        fs,
        path,
        root,
        Date.now() - 1,
        constants
      )('read_file', { path: 'hello.txt' })
    ).rejects.toThrow('deadline')
  })
})

it('pins the readable root when its original spelling is retargeted', async () => {
  const { root, parent } = await fixture()
  const alias = path.join(parent, 'root-alias')
  await fs.symlink(root, alias, 'dir')
  const tools = createOpenRouterWorkspace(fs, path, alias, Date.now() + 10000, constants)
  expect(await tools('read_file', { path: 'hello.txt' })).toContain('one')
  await fs.unlink(alias)
  await fs.symlink(parent, alias, 'dir')
  await expect(tools('read_file', { path: 'secret' })).rejects.toThrow()
  expect(await tools('read_file', { path: 'hello.txt' })).toContain('one')
  await fs.rename(root, path.join(parent, 'moved'))
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'hello.txt'), 'replacement')
  await expect(tools('read_file', { path: 'hello.txt' })).rejects.toThrow('root changed')
})
