function required(env, name) {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for signed Windows releases`)
  }
  return value
}

function windowsReleaseSigning(env = process.env) {
  const publisherName = required(env, 'OMNI_WINDOWS_PUBLISHER_NAME')
  const provider = env.OMNI_WINDOWS_SIGNING_PROVIDER?.trim() || 'certificate'
  if (provider === 'certificate') {
    return { signtoolOptions: { publisherName } }
  }
  if (provider !== 'azure') {
    throw new Error('Unknown Windows signing provider')
  }
  const endpoint = required(env, 'OMNI_WINDOWS_SIGNING_ENDPOINT')
  if (!/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/.test(endpoint)) {
    throw new Error('Windows signing endpoint must be an Azure Artifact Signing endpoint')
  }
  return {
    azureSignOptions: {
      publisherName,
      endpoint,
      codeSigningAccountName: required(env, 'OMNI_WINDOWS_SIGNING_ACCOUNT'),
      certificateProfileName: required(env, 'OMNI_WINDOWS_SIGNING_PROFILE')
    }
  }
}

function verifyWindowsReleaseEnv(env = process.env) {
  if (env.OMNI_WINDOWS_RELEASE !== '1') {
    throw new Error('OMNI_WINDOWS_RELEASE must be 1')
  }
  const config = windowsReleaseSigning(env)
  const credentials = config.azureSignOptions
    ? ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID']
    : ['CSC_LINK', 'CSC_KEY_PASSWORD']
  for (const name of credentials) {
    required(env, name)
  }
  return config
}

module.exports = { windowsReleaseSigning, verifyWindowsReleaseEnv }
if (require.main === module) {
  verifyWindowsReleaseEnv()
  console.log('Windows signing configuration verified; signature validation is still required')
}
