// Source capture compares these exact read-only shapes before and after reading file bytes.
const SOURCE_SNAPSHOT_READS = [
  ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none'],
  ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
  [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--ignore-submodules=none',
    '--name-only',
    '-z',
    'HEAD',
    '--'
  ],
  ['diff', '--no-ext-diff', '--no-renames', '--diff-filter=D', '--name-only', '-z', 'HEAD', '--'],
  ['ls-tree', '-r', '-z', 'HEAD']
]

export function isSourceSnapshotGitExec(args: string[]): boolean {
  return SOURCE_SNAPSHOT_READS.some(
    (shape) => shape.length === args.length && shape.every((arg, index) => arg === args[index])
  )
}
