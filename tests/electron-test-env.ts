export const createHeadlessElectronRuntimeEnv = (
  overrides: Record<string, string | undefined>,
) => {
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      CHILL_VIBE_HEADLESS_RUNTIME_TESTS: '1',
      ...overrides,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  delete env.ELECTRON_RUN_AS_NODE

  return env
}
