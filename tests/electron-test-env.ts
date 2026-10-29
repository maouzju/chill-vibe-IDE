export const createHeadlessElectronRuntimeEnv = (
  overrides: Record<string, string | undefined>,
) => {
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      CHILL_VIBE_HEADLESS_RUNTIME_TESTS: '1',
      // Startup model discovery hits the machine's real endpoint and pops a
      // full-page dialog at a network-dependent moment; keep runtime tests offline.
      CHILL_VIBE_DISABLE_MODEL_DISCOVERY: '1',
      ...overrides,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  delete env.ELECTRON_RUN_AS_NODE

  return env
}
