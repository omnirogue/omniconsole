export function shouldAutomaticallyDownloadUpdate(options: {
  platform: NodeJS.Platform
  source: string
  interactive: boolean
  manualInstall: boolean
  pinnedBuild: boolean
}): boolean {
  return (
    (options.platform === 'darwin' || options.platform === 'win32') &&
    options.source === 'release' &&
    options.interactive &&
    !options.manualInstall &&
    !options.pinnedBuild
  )
}
