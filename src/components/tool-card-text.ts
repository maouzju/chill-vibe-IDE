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
  emptyTitle: language === 'en' ? 'Open a file to start editing.' : '\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u4ef6\u518d\u5f00\u59cb\u7f16\u8f91\u3002',
  emptyDescription:
    language === 'en'
      ? 'Use Files or a generated plan result to open one here.'
      : '\u53ef\u4ee5\u4ece\u300c\u6587\u4ef6\u300d\u5361\u6216\u8ba1\u5212\u7ed3\u679c\u91cc\u6253\u5f00\u3002',
})
