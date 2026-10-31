export const defaultSystemPrompt =
  '如果用户寻求问题的解决而不是纯聊天或者发散，在最终答复的最后，必须用一句简短的话明确说明结果：如果问题已解决，只写“已解决”；如果问题尚未解决，只写“尚未解决：”并附上明确、合理的原因'

export type ModelPromptRule = {
  id: string
  modelMatch: string
  prompt: string
}

export const normalizeSystemPrompt = (value?: string | null) => {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : defaultSystemPrompt
}

// 10-31 用户反馈：设置里系统提示词最后一行回车换不了行。
// 根因：updateSettings 每次按键都走 normalizeAppSettings → trim，末尾换行被立刻吃掉。
// 存储层只做空值回退、保留原文；发给模型前再由 normalizeSystemPrompt trim。
export const normalizeStoredSystemPrompt = (value?: string | null) =>
  typeof value === 'string' && value.trim().length > 0 ? value : defaultSystemPrompt

export const normalizeModelPromptRules = (
  rules?: Array<Partial<ModelPromptRule> | null | undefined> | null,
): ModelPromptRule[] =>
  Array.isArray(rules)
    ? rules.flatMap((rule, index) => {
        const modelMatch = rule?.modelMatch?.trim() ?? ''
        const prompt = rule?.prompt?.trim() ?? ''

        if (!modelMatch || !prompt) {
          return []
        }

        return [{
          id: rule?.id?.trim() || `model-prompt-rule-${index + 1}`,
          modelMatch,
          prompt,
        }]
      })
    : []

export const getMatchingModelPromptRules = (
  model: string | null | undefined,
  rules?: Array<Partial<ModelPromptRule> | null | undefined> | null,
) => {
  const normalizedModel = model?.trim().toLowerCase() ?? ''

  if (!normalizedModel) {
    return [] as ModelPromptRule[]
  }

  return normalizeModelPromptRules(rules).filter((rule) =>
    normalizedModel.includes(rule.modelMatch.toLowerCase()),
  )
}

export const buildSystemPromptForModel = (
  basePrompt: string | null | undefined,
  model: string | null | undefined,
  rules?: Array<Partial<ModelPromptRule> | null | undefined> | null,
) => {
  const normalizedBasePrompt = normalizeSystemPrompt(basePrompt)
  const promptParts = [
    normalizedBasePrompt,
    ...getMatchingModelPromptRules(model, rules)
      .filter((rule) => !normalizedBasePrompt.includes(rule.prompt))
      .map((rule) => rule.prompt),
  ].filter((value) => value.trim().length > 0)

  return promptParts.join('\n\n')
}
