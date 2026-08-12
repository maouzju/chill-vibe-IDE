import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '_scaffold', '.chill-vibe']),
  {
    files: ['src/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.browser,
    },
  },
  {
    files: ['server/**/*.ts', 'vite.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
  {
    files: ['tests/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
  // 症状：electron/ 是主进程与 IPC 桥所在地，却从来没有被 lint 覆盖过 —— 报错
  //       "File ignored because no matching configuration was supplied"，未用变量、
  //       floating promise 这类问题在整个 Electron 层是盲区。
  // 根因：上面三段 files 只列了 src/shared、server、tests，漏了 electron/。而
  //       2026-08-12 把后端搬进 utilityProcess 的改造正好全落在这个目录，108 个 IPC
  //       handler 要换传输方式，正确性几乎全靠形状对齐，恰恰最需要静态守门。
  // 为什么不能换写法：typecheck 覆盖不能替代 lint —— tsc 不报未用变量之外的那些
  //       规则，而 Proxy 化之后"忘了 await"正是最典型的静默故障。
  //       纳入实测零成本：28 个文件 0 error 0 warning。
  {
    files: ['electron/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
])
