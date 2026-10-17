export function getOrcaCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'omni-ide'
  }
  if (platform === 'win32') {
    return 'omni.cmd'
  }
  return 'omni'
}
