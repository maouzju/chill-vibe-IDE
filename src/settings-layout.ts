import { createDefaultEditorSettings } from '../shared/default-state'
import type { AppSettings } from '../shared/schema'

// 症状：编辑器设置并入外观分组后，组内的「重置界面默认值」按钮只重置缩放/主题，编辑器子模块纹丝不动。
// 根因：该按钮的 patch 是内联字面量，2026-08-16 合并分组时它的作用域从「外观组」变成了「外观 + 编辑器组」。
// 被否决方案：把按钮挪到编辑器子模块之后当作纯外观按钮——那样组内会出现夹在两个子模块中间的操作条，违反卡片底部操作的排版约定。
export const createInterfaceDefaultsPatch = (): Partial<AppSettings> => ({
  uiScale: 1,
  fontFamily: 'default',
  fontScale: 1,
  lineHeightScale: 1,
  theme: 'light',
  customThemeBase: 'dark',
  customBaseColor: null,
  accentColor: null,
  editor: createDefaultEditorSettings(),
})
