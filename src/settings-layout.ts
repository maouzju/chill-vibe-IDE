export const stableSettingsPanelColumnThresholdPx = 26 * 16 * 2 + 16

export const getStableSettingsPanelColumnCount = (panelWidth: number) =>
  panelWidth >= stableSettingsPanelColumnThresholdPx ? 2 : 1

export const splitSettingsGroupsIntoStableColumns = <T>(
  groups: readonly T[],
  requestedColumnCount: number,
): T[][] => {
  const columnCount = requestedColumnCount >= 2 ? 2 : 1
  const columns = Array.from({ length: columnCount }, () => [] as T[])

  groups.forEach((group, index) => {
    columns[index % columnCount]?.push(group)
  })

  return columns
}
