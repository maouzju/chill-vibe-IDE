import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AppLanguage } from '../../../shared/schema'
import {
  filterSettingsItems,
  getBasicSettingsItems,
  getSettingsCategoryItems,
  getSettingsItemMeta,
  orderSettingsItems,
  settingsCategoryIds,
  type SettingsCategoryId,
  type SettingsItemMeta,
} from './settings-model'
import { getSettingsPanelText } from './settings-text'

export type SettingsPanelItem = {
  id: string
  node: ReactNode
}

export type SettingsPanelProps = {
  language: AppLanguage
  heading: string
  items: readonly SettingsPanelItem[]
  /** 常驻在内容区顶部的东西（环境健康卡）。 */
  banner?: ReactNode
  /** 外部请求聚焦某一项（健康卡「去连接账号」）。每次变化都会跳转一次。 */
  focusRequest?: { id: string; token: number } | null
}

type ResolvedItem = SettingsItemMeta & { node: ReactNode }
type SettingsView = 'basics' | SettingsCategoryId

export function SettingsPanel({ language, heading, items, banner, focusRequest }: SettingsPanelProps) {
  const text = getSettingsPanelText(language)
  // 落地页是「基础」：四个新手必看项。分类只在用户主动点左边导航时才切过去。
  const [activeView, setActiveView] = useState<SettingsView>('basics')
  const activeCategory: SettingsCategoryId = activeView === 'basics' ? 'get-started' : activeView
  const setActiveCategory = setActiveView as (view: SettingsView) => void
  const [query, setQuery] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState<Partial<Record<SettingsCategoryId, boolean>>>({})
  const contentRef = useRef<HTMLDivElement>(null)

  // 目录里没登记的 id 直接丢掉——这是 App.tsx 忘了登记的信号，宁可不显示也不要落到错的分类。
  const resolvedById = useMemo(() => {
    const map = new Map<string, ResolvedItem>()
    for (const item of items) {
      const meta = getSettingsItemMeta(item.id)
      if (meta) {
        map.set(item.id, { ...meta, node: item.node })
      }
    }
    return map
  }, [items])

  const trimmedQuery = query.trim()
  const searchResults = useMemo(() => {
    if (!trimmedQuery) {
      return null
    }
    const present = orderSettingsItems(
      settingsCategoryIds.flatMap((category) =>
        getSettingsCategoryItems(category).filter((meta) => resolvedById.has(meta.id)),
      ),
    )
    return filterSettingsItems(present, trimmedQuery).map((meta) => resolvedById.get(meta.id) as ResolvedItem)
  }, [resolvedById, trimmedQuery])

  const categoryItems = useMemo(
    () =>
      (activeView === 'basics' ? getBasicSettingsItems() : getSettingsCategoryItems(activeView))
        .filter((meta) => resolvedById.has(meta.id))
        .map((meta) => resolvedById.get(meta.id) as ResolvedItem),
    [activeView, resolvedById],
  )

  const basicItems = categoryItems.filter((item) => item.tier === 'basic')
  const advancedItems = categoryItems.filter((item) => item.tier === 'advanced')
  const regularAdvanced = advancedItems.filter((item) => !item.experimental && !item.danger)
  const leaveAloneItems = advancedItems.filter((item) => item.experimental || item.danger)
  const isAdvancedOpen = Boolean(advancedOpen[activeCategory])

  const setAdvanced = useCallback((category: SettingsCategoryId, open: boolean) => {
    setAdvancedOpen((current) => (current[category] === open ? current : { ...current, [category]: open }))
  }, [])

  // 外部聚焦请求在渲染期间同步吸收（React 的 "adjust state during render" 模式），
  // 这样切分类/展开高级和请求落在同一帧，effect 里只剩滚动这种 DOM 副作用。
  const [handledFocusToken, setHandledFocusToken] = useState(0)
  if (focusRequest && focusRequest.token !== handledFocusToken) {
    setHandledFocusToken(focusRequest.token)
    const meta = getSettingsItemMeta(focusRequest.id)
    if (meta) {
      setQuery('')
      setActiveCategory(meta.category)
      if (meta.tier === 'advanced') {
        setAdvanced(meta.category, true)
      }
    }
  }

  useEffect(() => {
    if (!focusRequest) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>(`#settings-item-${focusRequest.id}`)
        ?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRequest])

  const renderItem = (item: ResolvedItem, options: { showCategory?: boolean } = {}) => (
    <div
      key={item.id}
      id={`settings-item-${item.id}`}
      className={`settings-group settings-item${item.danger ? ' settings-group-danger' : ''}${
        item.experimental ? ' settings-group-experimental' : ''
      }`}
      data-settings-item={item.id}
      data-settings-tier={item.tier}
    >
      <div className="settings-item-head">
        <h3 className="settings-group-title">
          {item.label[language]}
          {item.experimental ? <span className="settings-tag settings-tag-experimental">{text.experimentalTag}</span> : null}
          {item.danger ? <span className="settings-tag settings-tag-danger">{text.dangerTag}</span> : null}
        </h3>
        {options.showCategory ? (
          <button
            type="button"
            className="settings-item-category-chip"
            onClick={() => {
              setQuery('')
              setActiveCategory(item.category)
              if (item.tier === 'advanced') {
                setAdvanced(item.category, true)
              }
            }}
          >
            {text.categories[item.category]}
          </button>
        ) : null}
      </div>
      {item.hint ? <p className="settings-note settings-item-hint">{item.hint[language]}</p> : null}
      {item.node}
    </div>
  )

  return (
    <section className="settings-panel settings-panel-beginner">
      <h2 className="visually-hidden">{heading}</h2>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={text.navLabel}>
          <label className="settings-search">
            <span className="visually-hidden">{text.searchLabel}</span>
            <input
              type="search"
              className="control settings-input settings-search-input"
              placeholder={text.searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-testid="settings-search"
            />
          </label>
          <div className="settings-nav-list" role="tablist" aria-orientation="vertical">
            <button
              id="settings-nav-basics"
              type="button"
              role="tab"
              aria-selected={!trimmedQuery && activeView === 'basics'}
              className={`settings-nav-item settings-nav-basics${!trimmedQuery && activeView === 'basics' ? ' is-active' : ''}`}
              onClick={() => {
                setQuery('')
                setActiveView('basics')
              }}
            >
              {text.basicsLabel}
            </button>
            {settingsCategoryIds.map((category) => {
              const active = !trimmedQuery && category === activeView
              return (
                <button
                  key={category}
                  id={`settings-nav-${category}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`settings-nav-item${active ? ' is-active' : ''}`}
                  onClick={() => {
                    setQuery('')
                    setActiveCategory(category)
                  }}
                >
                  {text.categories[category]}
                </button>
              )
            })}
          </div>
        </nav>

        <div className="settings-content" ref={contentRef}>
          {banner}

          {searchResults ? (
            <div className="settings-search-results" role="region" aria-label={text.searchLabel}>
              <p className="settings-note settings-search-summary">{text.searchResultsTitle(searchResults.length)}</p>
              {searchResults.length === 0 ? (
                <div className="settings-empty">
                  <span>{text.searchEmpty}</span>
                </div>
              ) : (
                searchResults.map((item) => renderItem(item, { showCategory: true }))
              )}
            </div>
          ) : (
            <div
              className="settings-category"
              role="tabpanel"
              aria-labelledby={`settings-nav-${activeView}`}
              data-settings-category={activeView}
            >
              <div className="settings-category-head">
                <h3 className="settings-category-title">
                  {activeView === 'basics' ? text.basicsLabel : text.categories[activeView]}
                </h3>
                <p className="settings-note">
                  {activeView === 'basics' ? text.basicsNote : text.categoryNotes[activeView]}
                </p>
              </div>

              {basicItems.map((item) => renderItem(item))}

              {advancedItems.length > 0 ? (
                <details
                  className="settings-advanced"
                  open={isAdvancedOpen}
                  onToggle={(event) => setAdvanced(activeCategory, (event.currentTarget as HTMLDetailsElement).open)}
                >
                  <summary className="settings-advanced-summary">
                    <span>{text.advancedSummary}</span>
                    <span className="settings-note">{text.advancedNote}</span>
                  </summary>
                  <div className="settings-advanced-body">
                    {regularAdvanced.map((item) => renderItem(item))}
                    {leaveAloneItems.length > 0 ? (
                      <div className="settings-leave-alone" data-testid="settings-leave-alone">
                        <div className="settings-leave-alone-head">
                          <strong>{text.leaveAlone}</strong>
                          <span className="settings-note">{text.leaveAloneNote}</span>
                        </div>
                        {leaveAloneItems.map((item) => renderItem(item))}
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
