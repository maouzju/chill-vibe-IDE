import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ChatManager } from '../server/chat-manager.ts'
import {
  captureWorkspaceSnapshot,
  describeStaleGitIndexLock,
  diffWorkspaceSnapshot,
  gitRunDefaultTimeoutMs,
  resolveGitRunTimeoutMs,
  superviseGitChild,
  type SupervisedGitChild,
} from '../server/git-workspace.ts'
import type { ChatRequest } from '../shared/schema.ts'

// 被测行为本身就是"到点必须放弃"，所以缺陷形态恰好是**永不 settle**。node --test
// 默认无超时，红阶段会挂死而不是报红，因此每条用例都要有自己的护栏。空载都在
// 100ms 量级，给到 15s（≈150x 余量）以免全量套件抢 CPU 时假红（pitfall 249/255）。
const guardedTest = { timeout: 15_000 }
// 起真实临时仓库的用例另算：本机 git spawn 实测 p90=1831ms（正是本次要修的那个数），
// createTempRepo 的 6 次 spawn 实测就要 ~10s，15s 的护栏会在护栏上假红。
const guardedRepoTest = { timeout: 120_000 }

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, message)
}

/**
 * A git child that has accepted the command and then goes silent forever —
 * the exact shape of the process that used to pin an unbounded `await` inside
 * the main process. Only the OS process is faked; the supervision logic under
 * test is the production one.
 */
class SilentGitChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = null
  readonly killSignals: (NodeJS.Signals | undefined)[] = []

  kill(signal?: NodeJS.Signals) {
    this.killSignals.push(signal)
    return true
  }
}

const createSilentGitChild = () => new SilentGitChild() satisfies SupervisedGitChild

const runGitCli = async (cwd: string, args: string[]) =>
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`git ${args.join(' ')} exited with ${code}`))
    })
  })

const createTempRepo = async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-git-timeout-'))
  await runGitCli(repoPath, ['init', '--initial-branch=main'])
  await runGitCli(repoPath, ['config', 'user.name', 'Chill Vibe Tests'])
  await runGitCli(repoPath, ['config', 'user.email', 'tests@example.com'])
  await writeFile(path.join(repoPath, 'tracked.txt'), 'base\n')
  await runGitCli(repoPath, ['add', 'tracked.txt'])
  await runGitCli(repoPath, ['commit', '-m', 'Initial commit'])
  return repoPath
}

// 症状 — 2026-08-13 全清单并发跑时，本文件唯一一条红是 t.after 里的
//   `EBUSY: resource busy or locked, rmdir 'C:\...\chill-vibe-git-timeout-XXXX'`；
//   同一文件单跑 12/12 全绿。断言本身从来没红过，红的是清理。
// 根因 — Windows 上进程退出与它对 cwd 的句柄释放不是同一时刻，被 kill 的 git 尤其如此
//   （TerminateProcess 没有收尾）。并发跑满时调度更挤，rmdir 正好撞在那道缝里。
// 为什么不是加 sleep — 缝的宽度取决于当时的机器负载，固定等待要么不够要么白等；
//   rm 自带的 maxRetries 是线性退避重试，正好只在真撞上时才付出代价。
const removeTempTree = async (targetPath: string) => {
  await rm(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

// 症状 — 应用"闪退"，实测退出码 0xCFFFFFFF（Windows 杀窗口无响应进程写的码）。
// 根因 — runGit 既无超时也无 kill，一个静默的 git 子进程就能让 await 永不返回，
//   而每个 git spawn 在这台机器上本身就是主线程同步阻塞（p90=1831ms、最坏 6910ms）。
// 所以这三条断言是同一件事：到点必须放弃、必须真杀进程、且不能把调用方拖住。
test('a silent git child is killed and the run gives up at the timeout', guardedTest, async () => {
  const child = createSilentGitChild()
  const startedAt = Date.now()

  await assert.rejects(
    superviseGitChild(child, ['status'], { timeoutMs: 40, killGraceMs: 20 }),
    /timed out/i,
    'a run without allowFailure must reject instead of hanging forever',
  )

  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs < 2_000, `the run must give up promptly, took ${elapsedMs}ms`)
  assert.ok(child.killSignals.length > 0, 'the timed-out child must actually be killed')
})

test('a timed-out run escalates to SIGKILL when the child ignores the first kill', guardedTest, async () => {
  const child = createSilentGitChild()

  await assert.rejects(superviseGitChild(child, ['status'], { timeoutMs: 20, killGraceMs: 30 }))

  await waitFor(
    () => child.killSignals.includes('SIGKILL'),
    'a child that never closes after SIGTERM must be escalated to SIGKILL',
  )
})

test('allowFailure turns a timeout into a quiet degraded result instead of a throw', guardedTest, async () => {
  const child = createSilentGitChild()

  const result = await superviseGitChild(child, ['status'], {
    timeoutMs: 40,
    killGraceMs: 20,
    allowFailure: true,
  })

  assert.equal(result.timedOut, true, 'the caller must be able to see the run was cut short')
  assert.notEqual(result.exitCode, 0, 'a timed-out run must never look like a success')
  assert.ok(child.killSignals.length > 0, 'the timed-out child must actually be killed')
})

// 给所有 40+ 个调用点套上同一个超时，代价是网络子命令会被误杀：一次慢网络上的
// `git pull` 跑几分钟是正常的。策略必须集中在一处，否则漏一个调用点就是一次误杀。
test('network git subcommands get a far larger budget than local ones', guardedTest, () => {
  assert.equal(
    resolveGitRunTimeoutMs(['status', '--porcelain=v1']),
    gitRunDefaultTimeoutMs,
    'local commands keep the local default',
  )

  for (const args of [
    ['fetch'],
    ['pull', '--no-rebase', '--autostash'],
    ['push', '-u', 'origin', 'main'],
    // 前导 flag 不能把子命令判定带偏。
    ['--no-pager', 'fetch'],
  ]) {
    const networkMs = resolveGitRunTimeoutMs(args)
    assert.ok(
      networkMs > gitRunDefaultTimeoutMs && networkMs >= 5 * 60_000,
      `${args.join(' ')} must not be killed on the local budget (got ${networkMs}ms)`,
    )
  }
  assert.equal(
    resolveGitRunTimeoutMs(['fetch'], 1_234),
    1_234,
    'an explicit budget always wins',
  )
})

// 症状 — 2026-08-13 用户报 `git commit -m ... --only --pathspec-from-file=- timed out
//   after 120000ms and was killed.`，除了"超时了"之外零线索，无从判断是 GPG 签名等
//   pinentry、pre-commit hook 卡住、还是 LFS 在刷大文件。
// 根因 — giveUp() 明明已经把 stdout/stderr 收在手里，却只在 allowFailure 分支把它们
//   resolve 出去；抛错分支只拼了一句 `timed out`，把唯一的现场证据丢了。正常失败走
//   formatGitFailure 是带 stderr 的，超时路径与它不一致。
test('a timed-out run surfaces the output git already produced', guardedTest, async () => {
  const child = createSilentGitChild()

  const runPromise = assert.rejects(
    superviseGitChild(child, ['commit', '-m', 'x'], { timeoutMs: 120, killGraceMs: 20 }),
    (error: Error) => {
      assert.match(error.message, /timed out/i, 'the timeout itself must stay in the message')
      assert.match(
        error.message,
        /error: gpg failed to sign the data/,
        'the stderr git already wrote is the only clue to why it hung — it must not be dropped',
      )
      return true
    },
  )

  child.stderr.write('error: gpg failed to sign the data\n')

  await runPromise
})

// 杀一个读命令（status/diff）没有后果；杀一个正在写 index 与 objects 的 commit 会把
// `.git/index.lock` 留在原地，用户随后的每一次 git 操作都会失败——比原来的慢更糟。
// Windows 上 kill 就是 TerminateProcess，git 连清理的机会都没有。所以本地写命令必须
// 拿到远超"正常但慢"的预算，而不是和 status 共用 120s。
test('local write subcommands get a larger budget than local reads', guardedTest, () => {
  for (const args of [
    ['commit', '-m', 'x', '--only', '--pathspec-from-file=-', '--pathspec-file-nul'],
    ['merge', 'origin/main'],
    ['rebase', '--continue'],
    ['cherry-pick', 'abc123'],
    ['revert', 'abc123'],
    ['stash', 'push'],
    ['-c', 'core.quotepath=false', 'commit', '-m', 'x'],
  ]) {
    const budgetMs = resolveGitRunTimeoutMs(args)
    assert.ok(
      budgetMs > gitRunDefaultTimeoutMs,
      `${args.join(' ')} must not be killed mid-write on the read budget (got ${budgetMs}ms)`,
    )
  }

  assert.equal(
    resolveGitRunTimeoutMs(['status', '--porcelain=v1']),
    gitRunDefaultTimeoutMs,
    'read commands keep the local default',
  )
  assert.equal(
    resolveGitRunTimeoutMs(['commit', '-m', 'x'], 1_234),
    1_234,
    'an explicit budget always wins',
  )
})

// 2026-08-13 实测：一个只有 1 个文件的仓库，commit 的 stderr 里已经有 2 行
// `warning: ... LF will be replaced by CRLF`；截图里那次提交是 58 个文件。这类换行符
// 提醒与卡死无关，却会把唯一有用的那行挤出摘录窗口——带上输出就等于没带。
test('the timeout excerpt drops CRLF noise so the real cause survives', guardedTest, async () => {
  const child = createSilentGitChild()

  const runPromise = assert.rejects(
    superviseGitChild(child, ['commit', '-m', 'x'], { timeoutMs: 120, killGraceMs: 20 }),
    (error: Error) => {
      assert.doesNotMatch(
        error.message,
        /LF will be replaced by CRLF/,
        'line-ending chatter must never crowd out the real cause',
      )
      assert.match(error.message, /gpg failed to sign/, 'the real cause must survive')
      return true
    },
  )

  for (let index = 0; index < 200; index += 1) {
    child.stderr.write(
      `warning: in the working copy of 'src/file-${index}.ts', LF will be replaced by CRLF the next time Git touches it\n`,
    )
  }
  child.stderr.write('error: gpg failed to sign the data\n')

  await runPromise
})

// 2026-08-13 实测（D:\Temp\git-hook-hang）：给仓库挂一个卡住的 pre-commit hook，让
// commit 在超时上被 kill，`.git/index.lock` 与 `next-index-*.lock` 就留在原地，紧接着
// 的 `git add` 直接 `fatal: Unable to create ... index.lock: File exists.`。用户看到的
// 第二个症状比第一个更吓人，而它完全是我们自己杀出来的——所以必须由我们说明。
test('a killed write leaves an index.lock the error has to own up to', guardedRepoTest, async (t) => {
  const repoPath = await createTempRepo()
  t.after(async () => {
    await removeTempTree(repoPath)
  })

  assert.equal(
    describeStaleGitIndexLock(repoPath),
    null,
    'a healthy repo must not be accused of holding a stale lock',
  )

  await writeFile(path.join(repoPath, '.git', 'index.lock'), '')

  const hint = describeStaleGitIndexLock(repoPath)
  assert.ok(hint, 'a leftover index.lock must be reported')
  assert.match(hint, /index\.lock/, 'the hint must name the file blocking every later git command')
})

// 症状 — 上一轮的 workspace diff 超时后只是 Promise.race 放弃等待，那一串 git 还在
//   跑，和下一轮的 diff 叠加成 spawn 风暴。
// 根因 — withHardTimeout 不 abort 也不 kill。这条钉住"取消信号能真正打断在跑的 git"。
test('aborting the signal kills the in-flight git child', guardedTest, async () => {
  const child = createSilentGitChild()
  const controller = new AbortController()

  const runPromise = superviseGitChild(child, ['status'], {
    timeoutMs: 30_000,
    killGraceMs: 20,
    allowFailure: true,
    signal: controller.signal,
  })

  setTimeout(() => controller.abort(), 20)

  const result = await runPromise
  assert.equal(result.aborted, true, 'an aborted run must report that it was cancelled')
  assert.ok(child.killSignals.length > 0, 'aborting must kill the child, not just stop awaiting it')
})

// 发消息前的这条路径此前完全没有超时保护。降级必须是安静的：返回 null（少一点
// diff）而不是抛错弹窗，否则用户会因为一个慢 git status 发不出消息。
test('captureWorkspaceSnapshot degrades to null instead of blocking the send', guardedRepoTest, async (t) => {
  const repoPath = await createTempRepo()
  t.after(async () => {
    await removeTempTree(repoPath)
  })

  // 刻意给一个远超生产默认值的预算：这条断言要证明的是"预算够用时照常出快照"，
  // 不该因为本机/全量套件下 git 变慢而假红（pitfall 249/255）。
  const healthy = await captureWorkspaceSnapshot(repoPath, { timeoutMs: 120_000 })
  assert.ok(healthy, 'a generous budget must still produce a snapshot')

  const startedAt = Date.now()
  const degraded = await captureWorkspaceSnapshot(repoPath, { timeoutMs: 1 })
  const elapsedMs = Date.now() - startedAt

  assert.equal(degraded, null, 'an over-budget snapshot must degrade quietly to null')
  // 时间上界只能松着断言，而且这条松散正是本 bug 的核心事实：**超时抢不走同步的
  // spawn()**。timeoutMs=1 时第一次 spawn 已经在飞，本机实测这一次就花了 9.3s
  // （2026-08-12，有负载）。所以"加超时"只解决累积和永久挂住，"少派生进程"才解决
  // 单次阻塞——两件事都要做，别把这里调紧当成修复。
  assert.ok(elapsedMs < 60_000, `the snapshot must stay bounded, took ${elapsedMs}ms`)
})

test('diffWorkspaceSnapshot stops quietly when its signal is already aborted', guardedRepoTest, async (t) => {
  const repoPath = await createTempRepo()
  t.after(async () => {
    await removeTempTree(repoPath)
  })

  const snapshot = await captureWorkspaceSnapshot(repoPath)
  await writeFile(path.join(repoPath, 'tracked.txt'), 'changed\n')

  // 反向对照：不取消时这个仓库确实有一个改动文件。没有这条，下面的空结果可能
  // 只是因为"本来就没东西可 diff"而假绿（pitfall 257）。
  const healthy = await diffWorkspaceSnapshot(snapshot, repoPath)
  assert.equal(healthy.files.length, 1, 'the uncancelled diff must still see the edit')

  const controller = new AbortController()
  controller.abort()

  const diff = await diffWorkspaceSnapshot(snapshot, repoPath, undefined, {
    signal: controller.signal,
  })

  assert.deepEqual(diff.files, [], 'an aborted diff must return empty instead of throwing')
})

// 症状 — 12s 硬超时到点后，那一串 git 仍在跑，下一轮的 diff 与上一轮的残余叠加。
// 根因 — withHardTimeout 只是 Promise.race，既不 abort 也不 kill。
test('the workspace diff hard timeout aborts the underlying git work', guardedTest, async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-diff-abort-'))
  t.after(async () => {
    await removeTempTree(workspacePath)
  })

  let observedSignal: AbortSignal | undefined

  const manager = new ChatManager({
    workspaceSnapshotter: async () => ({}) as never,
    workspaceDiffTimeoutMs: 40,
    workspaceDiffer: async (_snapshot, _workspacePath, _touched, limits) => {
      observedSignal = limits?.signal
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      return { files: [] }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return { kill: () => true } as unknown as ChildProcess
    },
  })
  t.after(() => manager.closeAll())

  const request = {
    streamId: 'workspace-diff-abort',
    cardId: 'card-workspace-diff-abort',
    provider: 'codex',
    prompt: 'test',
    workspacePath,
    attachments: [],
    model: '',
    reasoningEffort: 'max',
    thinkingEnabled: true,
    planMode: false,
    language: 'zh-CN',
    systemPrompt: '',
    modelPromptRules: [],
    crossProviderSkillReuseEnabled: true,
  } satisfies ChatRequest

  manager.createStream(request)

  await waitFor(() => observedSignal !== undefined, 'the differ must receive a cancellation signal')
  await waitFor(
    () => observedSignal?.aborted === true,
    'the hard timeout must abort the diff, not merely stop awaiting it',
  )
})
