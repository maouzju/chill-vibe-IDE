// Claude CLI 的能力探测——Codex 路的 `initialize` + `configRequirements/read` 在
// Claude 路的等价物。
//
// 症状 — 我们往 argv 里塞了一个 CLI 不认的参数，用户**看不到任何反馈**：功能像是
//   没生效，改设置毫无效果。pitfall #289 就是这么烧掉一整天的：`--effort none`
//   与随手拼错的 `--effort bogus` 输出完全相同的一行 stderr 警告并回落默认档，
//   而那行警告用户界面上一个字都看不到。
// 根因 — Claude 路**零握手**。Codex 至少有 initialize 与 configRequirements/read
//   可以逐级降级，Claude 侧我们从来没问过它认识什么。
// 为什么只诊断不自动跳过 — 解析 --help 是启发式的，误判会把**合法**参数丢掉，
//   代价远大于收益。这里只负责让"我们传了 CLI 不认的东西"变得可见。
//
// 性能约束（重要）— 这台机器上 spawn 本身是主线程同步阻塞，最坏单次 6.9s
// （pitfall #271）。所以探测**一个进程生命周期只跑一次**，结果缓存；调用方
// 绝不 await 它，第一回合不校验、之后的回合用缓存结果校验。

import { spawn } from 'node:child_process'

import { resolveProviderCommandLaunch } from './provider-command-launch.js'

const helpProbeTimeoutMs = 10_000

// 匹配 commander 风格的选项行：行首缩进 + 一个或多个用逗号分隔的参数名。
// 只认行首那一段，所以描述正文里的普通单词不会被误收。
const optionLinePattern = /^\s{2,}(-[^\s,]+(?:,\s*-[^\s,]+)*)/

/**
 * 从 `claude --help` 的输出里取出它真正接受的参数名集合。
 *
 * 解析不出来时返回空集合——调用方据此**完全跳过校验**（fail-open）。
 * 返回半个清单比返回空集合危险得多：那会把一堆合法参数误报成不支持。
 */
export const parseClaudeSupportedFlags = (helpText: string): Set<string> => {
  const flags = new Set<string>()

  for (const line of helpText.split(/\r?\n/)) {
    const matched = optionLinePattern.exec(line)
    if (!matched) {
      continue
    }

    for (const token of matched[1]!.split(',')) {
      const flag = token.trim()
      // 去掉 `<value>` / `[value]` 之类的占位，只留参数名本身。
      const name = flag.split(/[\s<[]/)[0]
      if (name && name.startsWith('-')) {
        flags.add(name)
      }
    }
  }

  return flags
}

/**
 * 找出 argv 里 CLI 不认识的参数名。
 *
 * 只看**参数名位置**的 token：紧跟在一个参数后面的值即使长得像参数
 * （负数、以 - 开头的字符串）也不校验，否则会误报。
 */
export const findUnsupportedClaudeFlags = (
  args: readonly string[],
  supported: ReadonlySet<string>,
): string[] => {
  if (supported.size === 0) {
    return []
  }

  const unsupported: string[] = []
  let previousWasFlag = false

  for (const arg of args) {
    const looksLikeFlag = arg.startsWith('--') || /^-[A-Za-z]$/.test(arg)

    if (looksLikeFlag && !previousWasFlag) {
      const name = arg.split('=')[0]!
      if (!supported.has(name)) {
        unsupported.push(name)
      }
    }

    previousWasFlag = looksLikeFlag && !previousWasFlag
  }

  return unsupported
}

let cachedProbe: Promise<Set<string>> | null = null

const runHelpProbe = async (command: string, env: NodeJS.ProcessEnv) => {
  // 必须走和真实回合同一条启动解析：Windows 上 `claude` 是个 .cmd shim，
  // 直接 spawn 裸命令名拿不到任何输出。2026-08-16 第一版就是这么写的，
  // 单测全绿而真实探测返回 0 个参数——一个永远不工作的功能，同 pitfall #283。
  const launch = await resolveProviderCommandLaunch({ command, args: ['--help'] })

  return new Promise<Set<string>>((resolve) => {
    let settled = false
    const finish = (flags: Set<string>) => {
      if (!settled) {
        settled = true
        resolve(flags)
      }
    }

    try {
      const child = spawn(launch.command, launch.args, { env, windowsHide: true })
      let stdout = ''
      const timer = setTimeout(() => {
        child.kill()
        finish(new Set())
      }, helpProbeTimeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(new Set())
      })
      child.on('close', () => {
        clearTimeout(timer)
        finish(parseClaudeSupportedFlags(stdout))
      })
    } catch {
      finish(new Set())
    }
  })
}

/**
 * 拿到本机 Claude CLI 支持的参数集合；一个进程生命周期只真正探测一次。
 *
 * 调用方**不要 await** 它（见文件顶部的 spawn 阻塞说明）。
 */
export const getClaudeSupportedFlags = (command: string, env: NodeJS.ProcessEnv) => {
  cachedProbe ??= runHelpProbe(command, env)
  return cachedProbe
}

/** 仅供测试：清掉进程级缓存。 */
export const resetClaudeCapabilityCacheForTests = () => {
  cachedProbe = null
}
