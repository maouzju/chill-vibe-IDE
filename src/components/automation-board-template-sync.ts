import { normalizeModel } from '../../shared/models'
import { normalizeReasoningEffortForModel } from '../../shared/reasoning'
import type { AutomationBoardTemplate, ChatCard, Provider } from '../../shared/schema'

/**
 * 把模板当前的执行参数带到它复用的那张实例卡上，需要改什么就返回什么。
 *
 * 症状：在模板配置面板把模型换成 Claude，触发器跑起来的监工仍然是
 *   codex/gpt-5.6-sol，思考也还是关着 —— 用户读作"配置根本没保存"
 *   （2026-08-16 用户存档实证：模板 provider=claude/model=''，
 *   实例卡 provider=codex/model=gpt-5.6-sol/thinkingEnabled=false）。
 * 根因：触发器**复用**上一轮的实例卡是为了保住跨轮上下文，而复用分支只做了
 *   换道 + 投递需求，从没回头看模板的执行参数变没变；只有"新建实例"那条
 *   分支带全套参数。
 * 为什么不是在模板改动时就写卡：模板与实例是一对多且实例随时可能不存在，
 *   把同步放在"要用它跑一轮"的那一刻，才不需要维护反向索引。
 *
 * 注意这**不是** pitfall #40 说的那种级联：那条禁止的是全局默认模型去改用户
 * 手开的卡；这里的实例卡是模板自己的产物，模板就是它唯一的配置源。
 */
export type AutomationBoardTemplateInstanceSync = {
  /**
   * provider/model 真的变了才有。调用方必须走 `selectCardModel` 而不是
   * `updateCard`：换模型要连带作废旧 session（pitfall 47），普通 patch 不做这件事。
   */
  model?: { provider: Provider; model: string }
  /** 其余执行参数的浅 patch。全都没变时这个字段不出现。 */
  patch?: Partial<ChatCard>
}

type SyncableCard = Pick<
  ChatCard,
  'provider' | 'model' | 'reasoningEffort' | 'thinkingEnabled' | 'planMode' | 'adminAccess'
>

export const resolveAutomationBoardTemplateInstanceSync = (
  template: AutomationBoardTemplate,
  card: SyncableCard,
): AutomationBoardTemplateInstanceSync | null => {
  // 模板的 `model: ''` 表示"用默认模型"，而卡上必须是一个具体型号 —— 与
  // reducer 里 createAutomationBoardItem 建卡时同一条规则，别在这里另写一份。
  const nextModel = normalizeModel(template.provider, template.model)
  const currentModel = normalizeModel(card.provider, card.model)
  const modelChanged = card.provider !== template.provider || currentModel !== nextModel

  // 深度档位随 provider/model 变，所以要按**将要生效的**模型归一化，不能拿
  // 模板里存的原值直接钉上去（Codex 老模型上的 max/ultra 会被 CLI 当场拒绝）。
  const nextReasoningEffort = normalizeReasoningEffortForModel(
    template.provider,
    nextModel,
    template.reasoningEffort,
  )

  const patch: Partial<ChatCard> = {}
  // 模型要动时**无条件**重申档位，哪怕它和卡上现在的值一模一样。
  //
  // 症状（2026-08-16 发布前审计）：模板 = claude/opus + 高，实例卡 = claude/sonnet
  //   + 高。只有模型不同，于是档位被判成"没变"不进 patch —— 而这一轮实际跑在
  //   "max"上，因为 `selectCardModel` 的最后一步会把档位改写成该模型被记住的
  //   偏好档（`getPreferredReasoningEffort`，src/state.ts）。
  // 根因：换模型不是一个纯粹的"设 model"，它连带重置档位；本模块算 diff 时看的
  //   是换模型**之前**的卡。
  // 为什么不换写法：调用方把 patch 排在换模型之后（src/App.tsx），所以重申一次
  //   就能把值压回来；改成"算 diff 时预演 selectCardModel"要把 settings 也传进来，
  //   等于把 reducer 的内部规则复制一份到渲染层。
  const effortChanged =
    normalizeReasoningEffortForModel(card.provider, currentModel, card.reasoningEffort ?? '') !==
    nextReasoningEffort
  if (modelChanged || effortChanged) {
    patch.reasoningEffort = nextReasoningEffort
  }
  if ((card.thinkingEnabled ?? true) !== template.thinkingEnabled) {
    patch.thinkingEnabled = template.thinkingEnabled
  }
  if ((card.planMode ?? false) !== template.planMode) {
    patch.planMode = template.planMode
  }
  if ((card.adminAccess ?? false) !== template.adminAccess) {
    patch.adminAccess = template.adminAccess
  }

  const hasPatch = Object.keys(patch).length > 0
  if (!modelChanged && !hasPatch) {
    return null
  }

  return {
    ...(modelChanged ? { model: { provider: template.provider, model: nextModel } } : {}),
    ...(hasPatch ? { patch } : {}),
  }
}
