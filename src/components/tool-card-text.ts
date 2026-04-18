import type { AppLanguage } from '../../shared/schema'

export const getFileTreeCardText = (language: AppLanguage) => ({
  loading: language === 'en' ? 'Loading files...' : '\u52a0\u8f7d\u6587\u4ef6\u4e2d...',
  searchPlaceholder: language === 'en' ? 'Search files' : '\u641c\u7d22\u6587\u4ef6',
  searchLabel: language === 'en' ? 'Search files' : '\u641c\u7d22\u6587\u4ef6',
  clearSearch: language === 'en' ? 'Clear' : '\u6e05\u9664',
  searching: language === 'en' ? 'Searching files...' : '\u641c\u7d22\u6587\u4ef6\u4e2d...',
  emptySearch: language === 'en' ? 'No files match this search.' : '\u6ca1\u6709\u627e\u5230\u5339\u914d\u7684\u6587\u4ef6\u3002',
})

export const getTextEditorCardText = (language: AppLanguage) => ({
  loading: language === 'en' ? 'Loading...' : '\u52a0\u8f7d\u4e2d...',
  saving: language === 'en' ? 'Saving...' : '\u4fdd\u5b58\u4e2d...',
  unsaved: language === 'en' ? 'Unsaved' : '\u672a\u4fdd\u5b58',
})
