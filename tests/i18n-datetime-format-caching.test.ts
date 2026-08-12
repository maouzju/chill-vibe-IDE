import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatLocalizedDateTime,
  formatLocalizedTime,
  formatMessageHoverTimestamp,
} from '../shared/i18n.ts'
import { commitTimestamp } from '../src/components/git-utils.ts'

// 症状：CPU 吃紧时在流式输出中切 tab，主线程一次阻塞 1374ms（2026-08-11 实测，
//   CDP profile 栈顶 formatMessageHoverTimestamp 186ms + formatLocalizedTime 100ms）。
// 根因：这两个函数每次调用都 `new Intl.DateTimeFormat`，而 MessageBubble.tsx:418
//   一行里每个气泡就要调三次（hover 那个内部又调一次 time），切一次 tab 挂 271 个
//   气泡 = 813 次构造。Intl 构造要现加载 locale 数据，是 format() 的几十倍。
// 为什么不能换写法：格式化结果必须保持逐字符不变（下面的行为断言守着），
//   所以只能缓存 formatter 实例，不能改成手写字符串拼接绕过 Intl。

const countDateTimeFormatConstructions = (run: () => void) => {
  const original = Intl.DateTimeFormat
  let constructed = 0

  const spy = function (this: unknown, ...args: unknown[]) {
    constructed += 1
    return new (original as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args)
  } as unknown as typeof Intl.DateTimeFormat
  spy.supportedLocalesOf = original.supportedLocalesOf.bind(original)

  Intl.DateTimeFormat = spy
  try {
    run()
  } finally {
    Intl.DateTimeFormat = original
  }

  return constructed
}

test('同一语言下反复格式化时间只构造一次 Intl.DateTimeFormat', () => {
  // 先热一次，把首次构造排除在计数之外。
  formatLocalizedTime('zh-CN', '2026-08-11T10:00:00.000Z')

  const constructed = countDateTimeFormatConstructions(() => {
    for (let index = 0; index < 200; index += 1) {
      formatLocalizedTime('zh-CN', `2026-08-11T10:${String(index % 60).padStart(2, '0')}:00.000Z`)
    }
  })

  assert.equal(constructed, 0, `预热后不应再构造，实测构造了 ${constructed} 次`)
})

test('一个气泡的两次调用不会各自构造 formatter', () => {
  formatLocalizedTime('zh-CN', '2026-08-11T10:00:00.000Z')
  formatMessageHoverTimestamp('zh-CN', '2026-08-11T10:00:00.000Z')

  // 模拟 MessageBubble.tsx:418 —— 每个气泡 title + 正文各一次，hover 内部再一次。
  const constructed = countDateTimeFormatConstructions(() => {
    for (let index = 0; index < 271; index += 1) {
      const at = `2026-08-11T10:${String(index % 60).padStart(2, '0')}:00.000Z`
      formatMessageHoverTimestamp('zh-CN', at)
      formatLocalizedTime('zh-CN', at)
    }
  })

  assert.equal(constructed, 0, `271 个气泡预热后不应再构造，实测 ${constructed} 次`)
})

test('中英文各自缓存，互不串味', () => {
  const zh = formatLocalizedTime('zh-CN', '2026-08-11T10:00:00.000Z')
  const en = formatLocalizedTime('en', '2026-08-11T10:00:00.000Z')

  const constructed = countDateTimeFormatConstructions(() => {
    for (let index = 0; index < 50; index += 1) {
      formatLocalizedTime('zh-CN', '2026-08-11T10:00:00.000Z')
      formatLocalizedTime('en', '2026-08-11T10:00:00.000Z')
    }
  })

  assert.equal(constructed, 0)
  assert.equal(formatLocalizedTime('zh-CN', '2026-08-11T10:00:00.000Z'), zh)
  assert.equal(formatLocalizedTime('en', '2026-08-11T10:00:00.000Z'), en)
})

test('缓存不改变任何一个格式化结果', () => {
  const samples = [
    '2026-08-11T10:00:00.000Z',
    '2026-08-11T23:59:59.000Z',
    '2026-01-01T00:00:00.000Z',
    '2025-12-31T16:30:00.000Z',
  ]

  for (const language of ['zh-CN', 'en'] as const) {
    for (const sample of samples) {
      const viaCache = formatLocalizedTime(language, sample)
      const direct = new Intl.DateTimeFormat(language === 'en' ? 'en' : 'zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(sample))
      assert.equal(viaCache, direct, `${language} ${sample} 的 time 结果变了`)

      const viaCacheDateTime = formatLocalizedDateTime(language, sample)
      const directDateTime = new Intl.DateTimeFormat(language === 'en' ? 'en' : 'zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(sample))
      assert.equal(viaCacheDateTime, directDateTime, `${language} ${sample} 的 dateTime 结果变了`)
    }
  }
})

test('git 的提交时间戳复用同一个缓存，且结果与原先的 zh-CN 写法一致', () => {
  const samples = [
    '2026-08-11T10:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2025-12-31T16:30:00.000Z',
  ]

  for (const language of ['zh-CN', 'en'] as const) {
    for (const sample of samples) {
      // git-utils 原先硬写 'zh-CN'，i18n 走 normalizeLanguage 也落到 'zh-CN'，
      // 两条路本就等价 —— 但合并前仍拿旧写法逐样本比对，免得日后
      // normalizeLanguage 或 defaultAppLanguage 一改，这里悄悄换了输出格式。
      const legacy = new Intl.DateTimeFormat(language === 'en' ? 'en' : 'zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(sample))
      assert.equal(commitTimestamp(language, sample), legacy)
    }
  }

  commitTimestamp('zh-CN', samples[0]!)
  const constructed = countDateTimeFormatConstructions(() => {
    for (let index = 0; index < 100; index += 1) {
      commitTimestamp('zh-CN', samples[index % samples.length]!)
    }
  })
  assert.equal(constructed, 0, `commitTimestamp 预热后不应再构造，实测 ${constructed} 次`)
})

test('今天/昨天前缀仍然按日历日判定', () => {
  const now = new Date('2026-08-11T12:00:00')
  const today = new Date('2026-08-11T09:30:00').toISOString()
  const yesterday = new Date('2026-08-10T23:30:00').toISOString()

  assert.equal(
    formatMessageHoverTimestamp('zh-CN', today, now),
    formatLocalizedTime('zh-CN', today),
    '今天不该加前缀',
  )
  assert.match(formatMessageHoverTimestamp('zh-CN', yesterday, now), /^昨天 /)
  assert.match(formatMessageHoverTimestamp('en', yesterday, now), /^Yesterday /)
})
