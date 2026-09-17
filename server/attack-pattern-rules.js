// 疑似供应链攻击形状检测（纯函数、无状态、不联网）。
//
// 设计约束（2026-09-17 玩家口述）：
//   1. 规则必须是「工具调用 → 判定」的纯函数：不看上下文、不看历史、不看意图。
//      凡是需要「想想这是要干嘛」的判断一律不进这里 —— 需要智力的判据无法自动化。
//   2. 因此本文件只覆盖「最省事那一档」攻击的机械特例，不做通用语义分析：
//      攻击者换个写法（分两步下载再执行、node -e 跑一段看着正常的代码）就绕过去了。
//      它的价值是「不需要人盯着、可以一直开、开了也不误伤」，不是拦住所有攻击。
//   3. 只报「能力」形状，不报「意图」：stdin 管道执行、编码执行、持久化写入、
//      切换包源、加密货币挖矿 / 常见 C2 回连端点。这些形状在工作流里没有合法用途。
//
// 命中后由 codex-destructive-command-guard.js 以独立退出码 3 上报：
//   3 = 疑似攻击形状（可选开关控制，默认关闭）
//   2 = 常规高风险操作（既有行为，默认开启）
// 退出码分开是为了让渲染层能区分「模型换个写法就行」和「要掐掉整个会话问用户」。

export const attackPatternFamilies = [
  'remote-pipe-exec',
  'encoded-exec',
  'persistence',
  'package-source-switch',
  'mining-or-c2',
]

export const attackPatternRules = [
  // ── 远程内容直接进解释器 ────────────────────────────────────────────
  {
    id: 'remote-pipe-to-shell',
    family: 'remote-pipe-exec',
    label: '管道的远程内容直接交给命令行解释器执行',
    pattern: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|DownloadFile|DownloadString)\b[^\r\n|]*\|[^\r\n|]*\b(?:ba|z|k|d)?sh\b/i,
  },
  {
    id: 'remote-pipe-to-iex',
    family: 'remote-pipe-exec',
    label: '管道的远程内容直接交给 PowerShell 表达式求值',
    pattern: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\r\n|]*\|[^\r\n|]*(?:Invoke-Expression|iex)\b/i,
  },
  {
    id: 'download-and-exec',
    family: 'remote-pipe-exec',
    label: '下载后立刻在同一命令里执行（分离两步，但仍是自动执行）',
    pattern: /(?:DownloadFile|DownloadString|curl\s+-[^\s]*[oO]|wget\s+-O|Out-File)[^\r\n;&|]*[;&|][^\r\n;&|]*\b(?:bash|sh|zsh|iex|Invoke-Expression|Start-Process)\b/i,
  },

  // ── 编码载荷 ───────────────────────────────────────────────────────
  {
    id: 'powershell-encoded-command',
    family: 'encoded-exec',
    label: 'PowerShell 以 base64 编码参数执行命令',
    // `-e` 这个分支会吃掉 `docker run -e SOME_TOKEN=<40+位 base64>` 这类常见用法。
    // PowerShell 的 -EncodedCommand 最短合法缩写是 -e，但只有紧跟 powershell/pwsh
    // 的位置才有该含义，所以要求同一条命令里确实出现了 PowerShell 可执行文件。
    pattern: /\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\r\n]{0,80}?(?:^|[\s"'=(])(?:-|--|\/)(?:e|en|enc|enco|encod|encode|encoded|encodedcommand)\b[^\r\n]{0,40}\b[A-Za-z0-9+/]{40,}={0,2}/i,
  },
  {
    id: 'base64-decode-to-shell',
    family: 'encoded-exec',
    label: 'base64 解码后的内容直接交给命令行解释器',
    pattern: /base64\s+(?:-[A-Za-z]*\s+)*-?d[^\r\n|]*\|[^\r\n|]*\b(?:ba|z|k)?sh\b/i,
  },
  {
    id: 'clr-from-base64',
    family: 'encoded-exec',
    label: '.NET 从 base64 字符串还原并执行代码',
    pattern: /\[(?:System\.)?Convert\]::FromBase64String|FromBase64String\s*\(/i,
  },
  {
    id: 'js-decode-exec',
    family: 'encoded-exec',
    label: 'JS 运行时对 base64 结果直接求值',
    pattern: /(?:eval|new\s+Function)\s*\(\s*(?:atob|Buffer\.from)\s*\(/i,
  },

  // ── 持久化 ─────────────────────────────────────────────────────────
  {
    id: 'windows-scheduled-task',
    family: 'persistence',
    label: '创建计划任务（把一次性动作变成每次开机都跑）',
    pattern: /\bschtasks\b[^\r\n;&|]*\/create\b|\bRegister-ScheduledTask\b|\bNew-ScheduledTask\b/i,
  },
  {
    id: 'windows-service-install',
    family: 'persistence',
    label: '安装 Windows 服务',
    // `\bsc\s+create\b` 不看上下文，`git commit -m "document sc create usage"` 也会中。
    // 要求 sc create 后面确实跟服务名与 binPath= 形态，或使用显式的 sc.exe。
    pattern: /\bsc\.exe\s+(?:create|config)\b|\bsc\s+create\s+[^\r\n;&|]*\bbinpath\s*=|\bNew-Service\b/i,
  },
  {
    id: 'registry-autostart',
    family: 'persistence',
    label: '写入注册表自启动项',
    // 正则字面量里 `\R` / `\W` 是 identity escape，等价于裸 R / W —— 原写法里的
    // `\Run` 退化成 `Run`，`pnpm run build`、`docker run`、`npm run test` 全部误命中，
    // 开关一开就掐会话。Windows 路径分隔符必须写成 `\`。
    // 同时要求前面确有注册表根键，单独一个 Run 子键不足以判定。
    pattern: /(?:HK(?:LM|CU|CR|U|CC)|HKEY_[A-Z_]+)[^\r\n;&|]*\\(?:CurrentVersion\\Run(?:Once)?|Winlogon)\b|\breg(?:\.exe)?\s+add\b[^\r\n;&|]*\\Run(?:Once)?\b/i,
  },
  {
    id: 'shell-profile-write',
    family: 'persistence',
    label: '追加写入 shell 启动脚本',
    // 持久化的形态是「追加」到启动脚本；单尖括号覆盖面太宽（普通重定向也中），
    // 且末尾 `\b` 让 `foo.zshrc.bak` 这类备份文件名照样命中，故要求路径到此结束。
    pattern: />>\s*[^\r\n;&|]*(?:\.bashrc|\.bash_profile|\.zshrc|\.profile|profile\.ps1|authorized_keys)(?=\s|$|['"])/i,
  },
  {
    id: 'unix-cron-write',
    family: 'persistence',
    label: '写入 crontab 或 launchd 持久项',
    // 原写法想排除只读的 `crontab -l`，但 `[^…]*` 可匹配空串、`\b` 落在 `-` 与 `l`
    // 之间，`(?!l\b)` 从未生效，`crontab -l` 照样命中。改为只认真正的写入选项。
    pattern: /\bcrontab\s+(?:-[^\r\n;&|]*\s+)?(?:-[er]\b|[^\r\n;&|]*\.cron\b)|\bcrontab\s+-\s*$|\blaunchctl\s+(?:load|bootstrap)\b/i,
  },

  // ── 切换包源（供应链控制入口）─────────────────────────────────────
  {
    id: 'npm-registry-switch',
    family: 'package-source-switch',
    label: '把 npm / pnpm / yarn 指向第三方源',
    // 症状一：`npm install --registry https://registry.npmjs.org/`（CI / Dockerfile 里
    //   最常见的写法）被判成攻击，开关一开首次安装就掐会话。
    // 根因：`--registry` 分支漏了官方源排除，只有裸 `registry=` 分支有，两个分支不对称。
    // 症状二：`https://registry.npmjs.org.evil.com/` 这种 typosquat 被放行。
    // 根因：负向前瞻没锚到主机名结束边界，`.org` 后面接什么都算「以官方源开头」。
    // 为什么不能只列域名：排除必须是「整个主机名相等」，所以前瞻里要跟上
    //   主机名的合法结束符（`/` `:` 空白 引号 行尾），否则前缀就能绕过。
    pattern: /(?:--registry[\s=]+|\bregistry\s*(?:=|\s)\s*|@[a-z0-9-]+:registry\s*=\s*)["']?https?:\/\/(?!(?:registry\.npmjs\.org|registry\.yarnpkg\.com)(?:[/:\s"']|$))/i,
  },
  {
    id: 'npmrc-write',
    family: 'package-source-switch',
    label: '写入包管理器源配置',
    pattern: />>?\s*[^\r\n;&|]*(?:\.npmrc|\.yarnrc|pip\.conf|\.pypirc|\.condarc)\b/i,
  },
  {
    id: 'pip-index-url',
    family: 'package-source-switch',
    label: '把 pip 指向第三方索引',
    // 同 npm-registry-switch：前瞻必须锚到主机名结束边界，否则
    // `https://pypi.org.evil.com/simple` 这种 typosquat 直接穿过。
    pattern: /(?:--index-url|--extra-index-url|index-url\s*=)[\s="']*https?:\/\/(?!(?:pypi\.org|files\.pythonhosted\.org)(?:[/:\s"']|$))/i,
  },

  // ── 挖矿 / 常见 C2 回连端点 ───────────────────────────────────────
  {
    id: 'mining-pool',
    family: 'mining-or-c2',
    label: '连接加密货币矿池',
    pattern: /stratum\+(?:tcp|ssl|http)s?:\/\/|\b(?:xmrig|minerd|cpuminer|coinhive|nicehash)\b/i,
  },
  {
    id: 'anonymity-network',
    family: 'mining-or-c2',
    label: '连接匿名网络端点',
    // 裸 `.onion` / `tor2web` 会命中 `cat notes.onion.md`、`grep -rn tor2web docs/`
    // 这类普通文件名与检索，安全类文档里天天出现。限定到 URL 或真正的执行位置：
    // `.onion` 必须出现在 URL 主机名里，`torsocks` 必须是被调用的命令。
    pattern: /https?:\/\/[^\s"']*\.onion\b|https?:\/\/[^\s"']*tor2web|(?:^|[;&|]\s*)torsocks\s/i,
  },
  {
    id: 'im-webhook-exfil',
    family: 'mining-or-c2',
    label: '向即时通讯机器人 / 公共粘贴站回传数据',
    pattern: /api\.telegram\.org\/bot|discord(?:app)?\.com\/api\/webhooks|pastebin\.com\/(?:raw|api)/i,
  },
]

// 症状：开关一开，agent 连这个功能自己的源码和文档都改不了 —— 规则表里的示例
//   字符串会触发规则表（自指陷阱）；只读工具（Read/WebFetch）也照样被扫。
// 根因：曾只看 tool_input 的字段名，从不看 tool_name，而同文件的
//   assessCodexToolUse 一上来就按工具类型分流，两者判据不一致。
// 为什么不能顺手也扫写入正文：写文件的正文里出现攻击字符串只是「写了段文本」，
//   不是「执行了它」；能力形状的判据必须落在真的会执行的那类调用上。
const shellToolPattern = /^(?:Bash|shell|shell_command|exec_command|write_stdin)$/i

const collectCandidates = (input) => {
  const toolName = input?.tool_name
  if (typeof toolName !== 'string' || !shellToolPattern.test(toolName)) {
    return []
  }

  const candidates = []
  const command = input?.tool_input?.command
  if (typeof command === 'string') {
    candidates.push(command)
  } else if (Array.isArray(command)) {
    for (const entry of command) {
      if (typeof entry === 'string') {
        candidates.push(entry)
      }
    }
  }
  return candidates
}

/**
 * 纯函数：对单次工具调用判定是否命中已知攻击形状。
 * 不读文件、不读网络、不看历史、无状态。
 */
export const detectAttackPatterns = (input) => {
  const candidates = collectCandidates(input)
  if (candidates.length === 0) {
    return []
  }

  const matches = []
  const seen = new Set()
  for (const candidate of candidates) {
    for (const rule of attackPatternRules) {
      if (seen.has(rule.id)) {
        continue
      }
      if (rule.pattern.test(candidate)) {
        seen.add(rule.id)
        matches.push({
          id: rule.id,
          family: rule.family,
          label: rule.label,
          sample: candidate.length > 400 ? `${candidate.slice(0, 400)}…` : candidate,
        })
      }
    }
  }
  return matches
}

export const formatAttackPatternReason = (matches) => {
  const listed = matches.map((match) => `「${match.label}」（规则 ${match.id}）`).join('、')
  return `检测到已知攻击形状：${listed}。命令未执行。`
}
