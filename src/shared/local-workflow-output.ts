/** Council output is an optional new Markdown file in the selected worktree root. */
export function localWorkflowOutputProblem(fileName: string | undefined): string | undefined {
  if (fileName === undefined || fileName === '') {
    return undefined
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md$/.test(fileName)) {
    return 'Use a Markdown filename in the worktree root (for example, PLAN.md). Paths and existing files are not allowed.'
  }
  return undefined
}
