#!/usr/bin/env node

import { resolve } from 'node:path'

export function getMacReleaseEnvironmentErrors(env) {
  const has = (key) => typeof env[key] === 'string' && env[key].trim().length > 0
  const errors = []
  if (!has('APPLE_TEAM_ID') || !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) {
    errors.push('APPLE_TEAM_ID must be the expected 10-character Apple team ID')
  }
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    errors.push('CSC_IDENTITY_AUTO_DISCOVERY=false is only allowed for unsigned evaluation builds')
  }

  if (has('CSC_LINK') || has('CSC_KEY_PASSWORD')) {
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
      if (!has(key)) {
        errors.push(`${key} is required for imported-certificate signing`)
      }
    }
  } else if (!has('CSC_NAME')) {
    errors.push(
      'CSC_NAME must select an installed Developer ID Application identity, or provide CSC_LINK and CSC_KEY_PASSWORD'
    )
  }
  if (has('CSC_NAME')) {
    const identity = /^Developer ID Application: [^\r\n\0]+ \(([A-Z0-9]{10})\)$/.exec(env.CSC_NAME)
    if (!identity || identity[1] !== env.APPLE_TEAM_ID) {
      errors.push(
        'CSC_NAME must be an exact Developer ID Application identity matching APPLE_TEAM_ID'
      )
    }
  }

  // electron-builder prefers Apple-ID/API credentials over a keychain profile.
  if (has('APPLE_KEYCHAIN_PROFILE')) {
    if (/[\r\n\0]/.test(env.APPLE_KEYCHAIN_PROFILE)) {
      errors.push('APPLE_KEYCHAIN_PROFILE must be a valid existing profile name')
    }
    if (
      [
        'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_API_KEY',
        'APPLE_API_KEY_ID',
        'APPLE_API_ISSUER'
      ].some(has)
    ) {
      errors.push(
        'Use APPLE_KEYCHAIN_PROFILE without Apple-ID or API credentials so the selected profile is used'
      )
    }
  } else {
    for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) {
      if (!has(key)) {
        errors.push(`${key} is required unless APPLE_KEYCHAIN_PROFILE is selected`)
      }
    }
    if (has('APPLE_KEYCHAIN')) {
      errors.push('APPLE_KEYCHAIN requires APPLE_KEYCHAIN_PROFILE')
    }
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const errors = getMacReleaseEnvironmentErrors(process.env)
  if (errors.length > 0) {
    console.error('macOS release signing environment is incomplete:')
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    console.error(
      'Use pnpm build:mac for unsigned evaluation builds. Release signing and notarization remain required.'
    )
    process.exitCode = 1
  }
}
