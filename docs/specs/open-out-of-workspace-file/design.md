# 技术方案 — 打开项目外文件

对应 [`requirements.md`](./requirements.md)。

## 核心判断：信任通道，而不是信任路径

两个可放行的位置，选了后者：

```
渲染进程 ──┬─ desktop:*  (Electron IPC, 只有本机渲染进程可达)   ← 在这里放行
           └─ POST /api/files/read (HTTP, HOST 可被改成 0.0.0.0) ← 保持严格
                                    ↓
                        server/file-system.ts 同一道闸
```

`src/api.ts:1375` `fetchFileContent` 早就按「有没有 desktop bridge」分叉，
`electron/backend.ts:683` 是桌面通道**唯一**的入口。因此放行信号根本不需要跨进程传递：
桌面入口自己在调用时写死 `{ allowOutsideWorkspace: true }`，HTTP 路由不传。

**收益是 zod schema 一行都不用改** —— `fileReadRequestSchema` 保持原样，
HTTP 请求体里没有任何新字段可以被外部构造，R2 的边界是结构性的而不是靠校验守住的。

## 改动点

### 1. `server/file-system.ts` — 闸门加 opt-in 参数

```ts
export type WorkspacePathGuardOptions = { allowOutsideWorkspace?: boolean }

export const ensureWithinWorkspace = (
  workspacePath: string,
  relativePath: string,
  options?: WorkspacePathGuardOptions,
): string
```

放行条件是 **`allowOutsideWorkspace` 且入参是绝对路径**，两者缺一不可：

- 绝对路径 = agent 结构化输出（`claude-structured-output.ts:290` 取 `file_path`）给的确定文件，
  是用户在 UI 上真的看见并点击的那一个。
- 相对路径 = 「在工作区里寻址」的语义，`../../etc/passwd` 是教科书式的 traversal 攻击形态，
  即使在桌面通道也没有任何正当用途，继续拒绝。

`ensureWithinWorkspaceCanonical` 同样透传 options：绝对路径 + opt-in 时跳过 realpath 根比对，
否则维持原样。这保证 **工作区内指向外部的 symlink/junction 在两种模式下都被拒**
（`tests/file-system.test.ts:55` / `:77` 走的是相对路径，断言不变）。

### 2. `electron/backend.ts` — 桌面入口显式 opt-in

`readFile` / `writeFile` / `copyFileToClipboard` / `watchFile` 四个方法传 `{ allowOutsideWorkspace: true }`。

**为什么写也放开**：agent 早就能改这些文件，用户在 IDE 里改同一个文件是同等权限；
只放读会让编辑器进入「打开了、改了、存不了」的状态，比打不开更糟（TextEditorCard 有 autosave）。

**为什么 `listFiles` / `searchWorkspaceFiles` 不放开**：那是目录遍历能力，
放开等于文件树可以翻全盘，是本次需求完全不需要的最大泄露面（requirements 非目标第一条）。

### 3. `server/file-watcher.ts:77` — 同一道闸，同样透传

不透传的话，项目外文件能打开但磁盘变更不刷新，回到「半残」。

### 4. `src/components/text-editor-load-failure.ts` — 说人话

新增 traversal 模式匹配 → 本地化文案。修复后桌面端不该再撞到它，
但浏览器/HTTP 模式下这条拒绝依然成立，裸英文错误不能留给用户。

## 被否决的方案

**A. 动态白名单（按 provenance 放行）**：服务端记录 agent 实际改过的项目外路径，只放行这些。
安全上最紧，但要在 `claude-structured-output.ts` / `codex-structured-output.ts` 里挂注册点，
还要解决重启后历史会话卡片的白名单丢失（要么持久化、要么点击历史卡又打不开 —— 正是本 bug 的复发）。
成本远高于收益：它试图防御的攻击者是「本机渲染进程」，而本机渲染进程本来就能通过桌面 IPC 执行 CLI。

**B. 无条件放开 `ensureWithinWorkspace`**：一行改完，但 HTTP 面同时被放开。
主 server 默认 loopback 只是默认值，`HOST=0.0.0.0`（`server/index.ts:115`）能改，
届时任意局域网设备可读整盘。否决。

**C. 前端不再放行、改成不可点**：能消灭错误提示，但等于确认「项目外文件永远看不了」，
与用户诉求相反。否决。

## 测试

| 测试 | 覆盖 |
|---|---|
| `tests/file-system.test.ts`（扩充，红先） | opt-in 下放行项目外绝对路径（`ensureWithinWorkspace` + `readWorkspaceFile` 真读文件）；默认仍拒绝；opt-in 下相对路径逃逸仍拒绝；opt-in 下 symlink 逃逸仍拒绝；写入 opt-in 放行 |
| `tests/text-editor-load-failure.test.ts` | traversal 错误被本地化，不再裸英文 |

现有断言全部保留（默认路径行为未变），这是本方案「默认严格 + 显式 opt-in」形状的直接好处。
