const { join } = require('node:path')

// These siblings must already be signed when codesign encounters the app executable.
// Intel linkers can leave them unsigned, unlike the arm64 linker defaults.
function signMacStandaloneHelpers({ app, identity, execute, entitlements }) {
  const args = ['--force', '--sign', identity]
  if (identity !== '-') {
    args.push('--options', 'runtime', '--timestamp')
  }
  if (entitlements) {
    args.push('--entitlements', entitlements)
  }
  for (const name of [
    'omni-notification-status',
    'omni-keyboard-layout',
    'omni-pty-process-observer'
  ]) {
    const helper = join(app, 'Contents', 'MacOS', name)
    execute('codesign', [...args, helper])
    execute('codesign', ['--verify', '--strict', helper])
  }
}

async function signMacAppWithStandaloneHelpers(options) {
  signMacStandaloneHelpers(options)
  return options.seal()
}

module.exports = { signMacStandaloneHelpers, signMacAppWithStandaloneHelpers }
