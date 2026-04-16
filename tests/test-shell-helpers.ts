import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const powerShellCommand = process.platform === 'win32' ? 'powershell' : 'pwsh'

export const prependPathEntry = (entry: string, currentPath = process.env.PATH ?? '') =>
  [entry, currentPath].filter(Boolean).join(path.delimiter)

const getShimPath = (dir: string, name: string) =>
  path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name)

export const writeArgCaptureShim = async ({
  dir,
  name,
  logEnvVar,
}: {
  dir: string
  name: string
  logEnvVar: string
}) => {
  const shimPath = getShimPath(dir, name)
  const contents =
    process.platform === 'win32'
      ? ['@echo off', 'setlocal', `echo %*>"%${logEnvVar}%"`, 'exit /b 0', ''].join('\r\n')
      : [
          '#!/usr/bin/env sh',
          `printf '%s\\n' "$*" > "\${${logEnvVar}}"`,
          'exit 0',
          '',
        ].join('\n')

  await writeFile(shimPath, contents, 'utf8')

  if (process.platform !== 'win32') {
    await chmod(shimPath, 0o755)
  }

  return shimPath
}

export const writeNodeEntrypointShim = async ({
  dir,
  name,
  entrypointPath,
}: {
  dir: string
  name: string
  entrypointPath: string
}) => {
  const shimPath = getShimPath(dir, name)
  const entrypointBaseName = path.basename(entrypointPath)
  const contents =
    process.platform === 'win32'
      ? [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=%',
          ')',
          `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entrypointBaseName}" %*`,
          '',
        ].join('\r\n')
      : [
          '#!/usr/bin/env sh',
          'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
          `exec node "$SCRIPT_DIR/${entrypointBaseName}" "$@"`,
          '',
        ].join('\n')

  await writeFile(shimPath, contents, 'utf8')

  if (process.platform !== 'win32') {
    await chmod(shimPath, 0o755)
  }

  return shimPath
}

