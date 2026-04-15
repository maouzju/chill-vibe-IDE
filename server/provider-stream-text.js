export const readStringPreserveWhitespace = (record, key) =>
  typeof record?.[key] === 'string' ? record[key] : undefined
