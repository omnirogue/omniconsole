import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_RUN_REPORT_MAX_BYTES,
  prepareLocalRunOutputRoot,
  readLocalRunReport
} from './local-run-artifacts'
import { localRunNodeOutputDir, localRunNodeReportPath } from './local-run-placement'

const workspaces: string[] = []

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'local-run-artifacts-'))
  workspaces.push(path)
  return path
}

afterEach(() => {
  for (const path of workspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('readLocalRunReport', () => {
  it('reads the dictated report and lists what the node produced', () => {
    const root = workspace()
    const outputDir = localRunNodeOutputDir(root, 'run_1', 'task_a')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'manifest.md'), '- cut.mp4: the rough cut')
    writeFileSync(join(outputDir, 'cut.mp4'), 'binary')
    writeFileSync(localRunNodeReportPath(root, 'run_1', 'task_a'), 'I cut the video.')
    const artifacts = readLocalRunReport({
      workspacePath: root,
      runId: 'run_1',
      taskId: 'task_a',
      reportedPath: localRunNodeReportPath(root, 'run_1', 'task_a'),
      reportBody: 'ignored'
    })
    expect(artifacts.source).toBe('report-file')
    expect(artifacts.text).toBe('I cut the video.')
    expect(artifacts.manifestPath).toBe(join(outputDir, 'manifest.md'))
    expect(artifacts.producedFiles).toEqual([
      join(outputDir, 'cut.mp4'),
      join(outputDir, 'manifest.md')
    ])
  })

  it('refuses a report path outside the workspace and falls back to the report body', () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.md'), 'not yours')
    const artifacts = readLocalRunReport({
      workspacePath: root,
      runId: 'run_1',
      taskId: 'task_a',
      reportedPath: join(outside, 'secret.md'),
      reportBody: 'what the worker said'
    })
    expect(artifacts.source).toBe('report-body')
    expect(artifacts.text).toBe('what the worker said')
    expect(artifacts.refusal).toMatch(/outside the workspace/)
  })

  it('refuses a traversal that escapes through the run folder', () => {
    const root = workspace()
    const artifacts = readLocalRunReport({
      workspacePath: root,
      runId: 'run_1',
      taskId: 'task_a',
      reportedPath: '.omni/runs/run_1/../../../../etc/passwd',
      reportBody: 'body'
    })
    expect(artifacts.source).toBe('report-body')
    expect(artifacts.refusal).toMatch(/outside the workspace/)
  })

  it('caps the inlined text at 256 KB and points at the full file', () => {
    const root = workspace()
    mkdirSync(join(root, '.omni', 'runs', 'run_1'), { recursive: true })
    const reportPath = localRunNodeReportPath(root, 'run_1', 'task_a')
    writeFileSync(reportPath, 'x'.repeat(LOCAL_RUN_REPORT_MAX_BYTES + 5_000))
    const artifacts = readLocalRunReport({
      workspacePath: root,
      runId: 'run_1',
      taskId: 'task_a',
      reportedPath: reportPath,
      reportBody: null
    })
    expect(artifacts.source).toBe('report-file')
    expect(artifacts.text.startsWith('x'.repeat(1_000))).toBe(true)
    expect(artifacts.text).toContain('truncated at 262144 bytes')
    expect(artifacts.text).toContain(reportPath)
    expect(Buffer.byteLength(artifacts.text)).toBeLessThan(LOCAL_RUN_REPORT_MAX_BYTES + 500)
  })

  it('falls back to the report body when the dictated file was never written', () => {
    const root = workspace()
    const artifacts = readLocalRunReport({
      workspacePath: root,
      runId: 'run_1',
      taskId: 'task_a',
      reportedPath: null,
      reportBody: 'no file, but this is what I did'
    })
    expect(artifacts.source).toBe('report-body')
    expect(artifacts.text).toBe('no file, but this is what I did')
    expect(artifacts.refusal).toMatch(/could not be read/)
    expect(artifacts.producedFiles).toEqual([])
  })
})

describe('prepareLocalRunOutputRoot', () => {
  it('creates the run folder and ignores only .omni/runs when a repository exists', () => {
    const root = workspace()
    const created = prepareLocalRunOutputRoot({
      workspacePath: root,
      runId: 'run_1',
      hasRepository: true
    })
    expect(created).toBe(join(root, '.omni', 'runs', 'run_1'))
    expect(readFileSync(join(root, '.omni', '.gitignore'), 'utf8')).toBe('runs/\n')
  })

  it('writes no .gitignore for a folder workspace', () => {
    const root = workspace()
    prepareLocalRunOutputRoot({ workspacePath: root, runId: 'run_1', hasRepository: false })
    expect(existsSync(join(root, '.omni', '.gitignore'))).toBe(false)
  })
})
