type WheelSample = Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'timeStamp'>

/**
 * 把一串 wheel 事件换算成「格」：1 = 向上滚一格，-1 = 向下一格，0 = 还不够一格。
 *
 * 鼠标一齿的 deltaY 会随 DPI 缩放变小（100% 约 100，300% 只剩 ~33），所以单个事件够大就
 * 直接算一格；触控板的一串小 delta 才累积，停顿 200ms 清零。思考档位旋钮与模型选择器共用。
 */
export const createWheelStepAccumulator = () => {
  let accumulated = 0
  let lastWheelAt = 0

  return (event: WheelSample): 1 | -1 | 0 => {
    const delta = event.deltaMode === 0 ? event.deltaY : event.deltaY * 40
    if (delta === 0) {
      return 0
    }
    if (event.timeStamp - lastWheelAt > 200) {
      accumulated = 0
    }
    lastWheelAt = event.timeStamp
    accumulated = Math.abs(delta) >= 16 ? delta : accumulated + delta
    if (Math.abs(accumulated) < 16) {
      return 0
    }
    const direction = accumulated < 0 ? 1 : -1
    accumulated = 0
    return direction
  }
}

// 流式中不提交滚轮预览：自动续跑等路径不经过发送按钮，计时器到点时卡片可能已在跑。
export const pickWheelPreviewToCommit = (input: {
  preview: string | null
  current: string
  streaming: boolean
}) => (input.preview === null || input.preview === input.current || input.streaming ? null : input.preview)
