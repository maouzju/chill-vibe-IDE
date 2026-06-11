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
  binaryTitle: language === 'en' ? 'Binary file' : '\u4e8c\u8fdb\u5236\u6587\u4ef6',
  binaryDescription:
    language === 'en'
      ? 'This file cannot be edited here.'
      : '\u6b64\u6587\u4ef6\u65e0\u6cd5\u5728\u8fd9\u91cc\u7f16\u8f91\u3002',
  tooLargeTitle: language === 'en' ? 'File too large' : '\u6587\u4ef6\u8fc7\u5927',
  tooLargeDescription:
    language === 'en'
      ? 'Files over 10 MB cannot be opened here.'
      : '\u8d85\u8fc7 10MB \u7684\u6587\u4ef6\u65e0\u6cd5\u5728\u8fd9\u91cc\u6253\u5f00\u3002',
  conflictMessage:
    language === 'en'
      ? 'File changed on disk while you had unsaved edits.'
      : '\u6587\u4ef6\u5728\u78c1\u76d8\u4e0a\u88ab\u4fee\u6539\uff0c\u4e0e\u672a\u4fdd\u5b58\u7684\u672c\u5730\u7f16\u8f91\u51b2\u7a81\u3002',
  conflictTakeDisk: language === 'en' ? 'Load disk version' : '\u52a0\u8f7d\u78c1\u76d8\u7248\u672c',
  conflictKeepMine: language === 'en' ? 'Keep my version' : '\u4fdd\u7559\u6211\u7684\u7248\u672c',
  conflictViewDiff: language === 'en' ? 'View diff' : '\u67e5\u770b\u5dee\u5f02',
  saveFailed: language === 'en' ? 'Save failed' : '\u4fdd\u5b58\u5931\u8d25',
  retry: language === 'en' ? 'Retry' : '\u91cd\u8bd5',
  compareWithHead: language === 'en' ? 'Compare with HEAD' : '\u5bf9\u6bd4 HEAD',
  exitDiff: language === 'en' ? 'Exit diff' : '\u9000\u51fa\u5bf9\u6bd4',
  switchEol: language === 'en' ? 'Switch line endings' : '\u5207\u6362\u6362\u884c\u7b26',
  copyFile: language === 'en' ? 'Copy file' : '\u590d\u5236\u6587\u4ef6',
  copyFileHint:
    language === 'en'
      ? 'Copy the file to the system clipboard'
      : '\u5c06\u6587\u4ef6\u590d\u5236\u5230\u7cfb\u7edf\u526a\u8d34\u677f',
  copied: language === 'en' ? 'Copied' : '\u5df2\u590d\u5236',
  copyFailed: language === 'en' ? 'Copy failed' : '\u590d\u5236\u5931\u8d25',
})
