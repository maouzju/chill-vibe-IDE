import type { AppLanguage } from '../../shared/schema'

export const getFileTreeCardText = (language: AppLanguage) => ({
  loading: language === 'en' ? 'Loading files...' : '加载文件中...',
  searchPlaceholder: language === 'en' ? 'Search files' : '搜索文件',
  searchLabel: language === 'en' ? 'Search files' : '搜索文件',
  clearSearch: language === 'en' ? 'Clear' : '清除',
  searching: language === 'en' ? 'Searching files...' : '搜索文件中...',
  emptySearch: language === 'en' ? 'No files match this search.' : '没有找到匹配的文件。',
})

export const getTextEditorCardText = (language: AppLanguage) => ({
  loading: language === 'en' ? 'Loading...' : '加载中...',
  saving: language === 'en' ? 'Saving...' : '保存中...',
  unsaved: language === 'en' ? 'Unsaved' : '未保存',
})
