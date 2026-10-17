import {
  DEFAULT_SESSION_ACTION_TEMPLATES,
  renderSessionActionTemplate
} from '../../../shared/session-action-presets'
import type { LocalRunNode } from '../../../shared/local-run-graph'
import type { LocalRunArtifacts } from './local-run-artifacts'

export type LocalRunNodeInput = {
  nodeId: string
  artifacts: LocalRunArtifacts
}

const MAX_INLINED_INPUT_FILES = 200

function inputFilesBlock(inputs: LocalRunNodeInput[]): string {
  const lines: string[] = []
  for (const input of inputs) {
    lines.push(`# from ${input.nodeId} (manifest: ${input.artifacts.manifestPath})`)
    for (const file of input.artifacts.producedFiles.slice(0, MAX_INLINED_INPUT_FILES)) {
      lines.push(file)
    }
    if (
      input.artifacts.producedFilesTruncated ||
      input.artifacts.producedFiles.length > MAX_INLINED_INPUT_FILES
    ) {
      lines.push(`# … more files under ${input.artifacts.outputDir}`)
    }
  }
  return lines.join('\n')
}

function inputTextBlock(inputs: LocalRunNodeInput[]): string {
  return inputs
    .map((input) =>
      [
        `--- ${input.nodeId} ---`,
        input.artifacts.refusal ? `(${input.artifacts.refusal})` : null,
        input.artifacts.text || '(no report text)'
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n')
}

/**
 * The instruction one node runs. The preset template is the whole brief — presets
 * must not assume code — and the runner adds only mechanical facts: where to write,
 * exactly which report path to pass back, and what every dependency produced.
 */
export function buildLocalRunNodeSpec(args: {
  node: LocalRunNode
  workspacePath: string
  outputDir: string
  reportPath: string
  inputs: LocalRunNodeInput[]
  template?: string
}): string {
  const template = args.template ?? DEFAULT_SESSION_ACTION_TEMPLATES[args.node.presetId]
  const rendered = renderSessionActionTemplate(template, {
    objective: args.node.objective,
    input: inputTextBlock(args.inputs),
    inputFiles: inputFilesBlock(args.inputs),
    outputDir: args.outputDir,
    workspacePath: args.workspacePath
  })
  return [
    rendered,
    '',
    'Reporting (mechanical, do not change these paths):',
    // Why two labelled lines: the dispatch preamble documents the --report-path
    // flag with its own placeholder, so the runner's dictated path needs a marker
    // that cannot be confused with the flag's documentation.
    `Report file: ${args.reportPath}`,
    `Output folder: ${args.outputDir}`,
    '- Write your report to exactly the Report file path above.',
    '- Send worker_done exactly once, passing that same path as --report-path, --outcome succeeded or failed, and --files-modified listing every file you produced.',
    '- succeeded means you produced the deliverable for THIS objective in this workspace. Anything outside it is a follow-up you list in the body, not a failure.',
    '',
    // Why this is spelled out: the live run's `plan` worker wrote its deliverable and
    // then stopped on a question a person had no reason to be asked, and a local run
    // is one person's own work — nobody is watching the mailbox. Deciding is the job.
    'Deciding (this step is yours to decide):',
    '- Decide and proceed. When something is ambiguous or underspecified, pick the option that best serves the objective and keep going. Do not stop to ask for a preference, a name, a style or an ordering.',
    '- Write every decision you made, and why, into your report. That is how the next step and the person see what you chose — and how they change it.',
    '- Ask ONLY if you are truly blocked: the work cannot proceed without a person. That means something you have no access to, an action that is irreversible or spends money, or a contradiction in the brief that no reading of the workspace resolves.',
    '- If you are blocked, send ask and WAIT for the reply. Never send worker_done while your own question is open, and never stop silently in your terminal.',
    '- This workspace is a folder of files of any kind. Do not assume it is a code repository: run no build, no test suite and no git command unless the objective or a file in the workspace names one.'
  ].join('\n')
}

/** The gate question a person answers before a gated node starts. */
export function localRunGateQuestion(node: LocalRunNode): string {
  return node.gate?.question ?? `Approve running ${node.id}?`
}
