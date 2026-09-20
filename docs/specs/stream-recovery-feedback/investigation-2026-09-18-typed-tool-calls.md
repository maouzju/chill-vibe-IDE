# 2026-09-18 Codex 工具调用变成正文取证

## 结论与边界

18:33 两个样本的异常在 Codex CLI 收到 `https://api.mouxihub.com/v1/responses` 响应时已经出现，不是 Chill Vibe 单纯把真实工具调用误渲染成文字。这个结论不覆盖所有“没有工具”截图，也尚不能排除 Chill Vibe 的请求配置与上游兼容性之间的交互。

两个独立会话在同一分钟出现同一组指纹：`cursor-sand-v1:` 字段标记、响应 ID 形态改变、正文中出现 `to=functions...`、CLI 报 `OutputTextDelta without active item`。高度怀疑该中转站当时路由到了不完整兼容 Codex 工具协议的转接通道。客户端证据不能进一步证明具体渠道、实际底层模型、是否丢弃工具定义或如何转换请求，需要服务商按请求编号查服务端日志。

本记录只做调查，没有修改执行逻辑、路由设置或用户会话。已检查 AGENTS.md、stream-recovery-feedback 与 native-agent-completion-boundary 现有设计；没有新增行为，因此不另建实施 SPEC、不触发打包或运行时重启。

## 本地证据源

- CLI 日志：`~/.codex/logs_2.sqlite`，通过 Node 内置 SQLite 以只读模式按 `thread_id` 与时间索引查询，没有全库扫描或复制。
- 主会话：`~/.codex/sessions/2026/09/18/rollout-2026-09-18T18-15-57-01a0b404-061d-7663-b46f-83a47f2a8276.jsonl`。
- 对照会话：`~/.codex/sessions/2026/09/18/rollout-2026-09-18T18-28-04-01a0b40f-1b16-7d62-b13f-89deb9c00448.jsonl`。
- 两会话均为 CLI `0.153.4`、请求模型 `gpt-6-astra`、provider 标识 `duckcoding`。该标识只是本地配置名称，实际请求域名以 HTTP 日志为准。

只记录协议元数据、计数和请求编号，不复制认证信息、完整业务转录或推理正文。

## 时间线

以下时间为北京时间 UTC+8，日志原始时间为 UTC。

| 时间 | 证据 |
| --- | --- |
| 18:32:59 至 18:33:00 | 主会话真实 `exec` 调用完成，随后继续采样；不是工具进程启动失败。 |
| 18:33:00 | CLI 日志 `74855894`：上下文估计 206559，自动压缩阈值 244800，`token_limit_reached=false`；两份 rollout 均没有 `compacted` 记录。 |
| 18:33:02 | 对照会话异常请求 HTTP 200，日志 `74855808`。 |
| 18:33:07 | 主会话异常请求 HTTP 200，日志 `74855905`，URL 为上面的远程 `/responses`，不是本机代理地址；日志 `74855907` 开始报 `OutputTextDelta without active item`。 |
| 18:33:07 至 18:34:19 | 主会话该错误累计 180 条；对照会话 18:33:02 至 18:34:21 累计 83 条。这是协议增量解析错误次数，不是重试次数。 |
| 18:34:29 | 主会话把 13 处 `to=functions` 与一个 `to=multi_tool_use.parallel` 写入同一条 assistant 普通正文，并报告无法访问工具，随后 `task_complete`。异常响应期间没有真实工具调用。 |
| 18:34:32 | 对照会话也输出含 4 处 `to=functions` 的普通正文。 |
| 18:38:49 至 18:39:13 | 主会话收到 `Please continue.` 后，在相同 provider/model 下恢复正常消息结构和真实 `exec` 调用。 |

## 响应对照

| 项目 | 主会话异常前 | 主会话异常响应 | 续发后 |
| --- | --- | --- | --- |
| response ID | `resp_08d273fefa3173e3016aad131e844487d0a3b612b5a8b44673` | `resp_365019f0ac7c43a59da89d7996e89066` | `resp_08d273fefa3173e3016aad14c3946c87d090c9b074a1a1c16e` |
| 上游报告 input tokens | 204384 | 12790 | 205989 |
| 推理字段前缀 | `gAAAAABq` | `cursor-sand-v1:` | 恢复正常响应 ID 与工具事件 |
| 工具行为 | `custom_tool_call: exec` | 普通 message 中出现调用文字 | `custom_tool_call: exec` |

对照会话同时从 82801 input tokens 变成 10314，异常 response ID 为 `resp_09dbac318c9842dc851a844182a77c6c`，同样出现 `cursor-sand-v1:`。这排除了“只有某个长会话达到自动压缩阈值”的解释。用量是服务端报告值，不能直接当作确证的实际上下文长度或上下文丢失量。

主会话三个不同 reasoning item 的摘要长度分别为 413、843、1285，后一个包含前一个的累计内容。截图里重复的三条思考行在 CLI 原始记录里已是三个独立 item，不是仅由 renderer 复制出来的。

## 服务商排查编号

端点：`https://api.mouxihub.com/v1/responses`。

响应头：`x-new-api-version: v4.9.49-v3`，两次 HTTP 状态均为 200。

| 会话 | x-oneapi-request-id | UTC 时间窗口 |
| --- | --- | --- |
| 主会话 | `MC202609181033031171949588268d9d6MXNrsw96` | 2026-09-18 10:33:03 至 10:34:29 |
| 对照会话 | `MC20260918103301196924198268d9d6YjNF6Tm5` | 2026-09-18 10:33:01 至 10:34:32 |

请服务商检查这两次请求实际命中的渠道、模型映射、`cursor-sand-v1` 标记来源，以及 Responses 工具定义和 `custom_tool_call` 的双向转换；并检查输出 item 生命周期事件是否缺失或乱序。没有上游原始请求/响应抓包，不能把上述哪一种内部实现缺陷写成已证实事实。

## 为什么没有自动重试

异常回复仍以 HTTP 200 和原生 `task_complete` 正常结束。Chill Vibe 的完成边界设计以原生终态为准，不能仅因正文声称“无法访问工具”就无条件续跑，否则正常的阻塞说明或普通协议讨论也可能被无限重试。即使隐藏这串文字，也不会恢复实际工具执行。

临时绕行应选择服务商确认支持 Codex 原生 Responses 工具协议的渠道；重装应用、放宽沙箱权限或仅清理气泡都不针对本次原因。此次调查不擅自切换用户路由，也不从普通回复里提取命令执行。

## 22:56 新截图复核：相似症状不等于同一已证根因

- 目标会话 `01a0b504-a5db-76f0-a3ec-951e7044b2ff`，工作区 `另一个无关的本地仓库`；对应 rollout 为 `~/.codex/sessions/2026/09/18/rollout-2026-09-18T22-56-15-01a0b504-a5db-76f0-a3ec-951e7044b2ff.jsonl`。
- 22:56:17 原生 turn context 为 `danger-full-access` / `approval_policy: never`，CLI `0.153.4`、模型 `gpt-6-astra`。22:56:32 直接回复“当前会话未提供文件读写或命令执行工具”，随即 `task_complete`，这一轮没有真实工具调用；这句话本身不是工具注册失败的证据。
- 22:58:54 用户发送 `Please continue.`；22:59:08.988 同一会话产生真实 `custom_tool_call: exec`，22:59:09.534 收到工具结果，此后继续读文件、执行命令。两轮的权限与模型相同，因此不能归因为持续性的本地权限关闭。没有代替用户重发业务请求，也没有改动路由或运行中会话。
- 续发 HTTP 日志 `75258831` 的实际 URL 仍为 `https://api.mouxihub.com/v1/responses`，请求编号 `MC202609181458573830745608268d9d6ghyAYK5f`。但只读按 thread/time 以及首次进程 `pid:9764:a95e3385-2ee5-40f4-915d-fd3d4770a794` 对拍时，首次响应期间的 HTTP/SSE 细节未找到；没有捕获该轮 `cursor-sand-v1:` 或 `OutputTextDelta without active item`，不能直接沿用下午的已证结论。
- 当前结论：此次“无工具”是间歇性现象，继续后已恢复真实工具调用；首次请求的工具定义是否完整到达上游、上游是否错误转接，以及模型是否误判，仍需首次原始请求/响应或服务商日志才能区分。不能把续发恢复宣称为根因修复，不能单凭自然语言拒绝就自动重跑原生已完成任务。

本次仅补充只读取证，不修改产品逻辑，不新增 SPEC、不触发构建或重启；遵循本 SPEC 与 native-agent-completion-boundary 的完成边界。

## 23:15 近期功能回归假设与独立探针

- 对比 `v0.20.21..HEAD`：`server/providers.ts` 的差异在 Claude 气泡恢复及 Claude 安全钩子设置，Codex 的 `thread/start`、`thread/resume` 与 `turn/start` 构造未变。不能由此排除其他模块或更早版本引入的交互。
- 发布版持久化设置中的 `attackPatternProtectionEnabled` 实际为 `true`，不能按“默认关闭”排除最新攻击检测功能。实现将它接入 `PreToolUse` 命令检查，没有删除工具定义；截图目标首次回合没有工具调用，因此尚不符合直接命令拦截的表现。尚未完成相同启动环境下的开关 A/B，不宣称排除该功能。
- 在临时空目录直接启动同一 Codex CLI，以同一服务商和模型做隔离探针。仅请求输出测试字符串；原始请求透传既有上游，响应在本地诊断代理处截断，工具命令不交给 CLI 执行，不重发用户业务请求。4 次初始捕获、1 次结构捕获及 1 次修正后捕获均返回真正的 `custom_tool_call: exec`；另有 1 次网络 `fetch failed`，不计作工具故障复现。测试绕过 Chill Vibe 运行时，但未复刻其完整启动参数，成功不能排除间歇性回归。
- **探针纠错：CLI 0.153.4 本次实际把工具放在 `input[]` 的 `type: additional_tools` 项里，并使用 namespace 包装，而非顶层 `tools`。** 初始 `probe-results.json` 的 `tools: []` 只说明旧统计漏读，不是工具缺失。修正后的 `probe-nested-results.json` 记录 `functions.exec` 等完整工具名称，`toolHash=f0540ca7f9361886be964e46f59d21acc3fca4807aeb9e7b639db617bdde0fd1`，请求编号 `MC202609181514541952984118268d9d69krJMlUy`。
- 新的待验证假设：转接渠道是否都识别 `additional_tools` / namespace 格式。当前只捕获正常样本，没有捕获失败请求，不能声称此格式就是根因，也不在产品中擅自重写协议或关闭防护。

本轮仅修正文档结论及本地诊断脚本；未修改产品代码、用户路由、安全开关或运行中的发布版。

## 2026-09-18 23:40 运行链路 A/B 与全量样本复核

- 使用真实 `launchProviderRun` 启动同一 CLI、同一服务商、同一模型、同一临时工作区，捕获 `/v1/responses` 原始请求后立即截断响应，**不把模型返回的命令交给 CLI 执行**。`attackPatternProtectionEnabled=true/false` 各 4 轮（另追加轮次复核）均返回真正的 `custom_tool_call`，工具哈希均为 `f0540ca7f9361886be964e46f59d21acc3fca4807aeb9e7b639db617bdde0fd1`，请求大小与指令哈希一致。攻击检测开关没有改变工具定义或请求结构，基本排除它是本故障触发器。
- 去掉随机 item/session/cache 标识后，开关 A/B 请求体的规范化 SHA-256 均为 `305d6a85bda440e89587c7ac0cf175cf3b90d3a218aa6380938f91af516232dc`；这比只比较工具数量更能排除“开关导致协议请求改变”。
- A/B 请求的工具实际位于 `input[0].type=additional_tools`，包含 `functions.exec`（`custom`）以及 `wait`、`sleep`、`list_agents` 等函数；不能再用顶层 `tools=[]` 判定“没有工具”。
- 对 `~/.codex/sessions/2026/09/01–09/18` 按 `session_meta` 归属、response item ID 去重后，9/1–9/17 没有同类“无文件/命令工具”消息；9/18 首轮异常集中出现。4 个晚间异常根会话均是 `gpt-6-astra`、`effort=high`、`danger-full-access`、`approval_policy=never`，且 `base_instructions` 相同，没有新增超管/adminAccess 提示。故不是默认超管提示或本地权限配置共因，也不是 9/18 当天 CLI 刚升级（CLI 0.153.4 至少自 9/6 已在运行）。
- 全日异常统计中，首轮异常直接落为 `item_*` 的 `message` 或 `function_call`；`function_call` 只出现 `list_agents`、`send_message`、`wait`、`sleep`、`spawn` 等普通 JSON 工具，`exec` 对应的新版 `custom_tool_call` 缺失。相邻正常轮次为 `ctc_* custom_tool_call: exec`。同一会话续发时可依次看到 `item_* function_call/list_agents`、`item_* function_call/wait`，随后恢复 `ctc_* custom_tool_call/exec`，说明 CLI/Chill Vibe 能处理工具，异常更像上游中转间歇性把新版 Responses item 类型降级或混用，而非 renderer 丢失工具。
- 两个可回溯的晚间首轮请求：`MC202609181456352318531328268d9d6IbIL60nH`（约 22:56:41）与 `MC202609181506014622777108268d9d6CwW7lFu2`（约 23:06:06），均 `POST https://api.mouxihub.com/v1/responses`、HTTP 200；响应直接出现 `item_*` 普通 message，约 10ms 后记 token_count，`reasoning_output_tokens=0`，随即 `task_complete`。这与“上游返回错误 item 类型”相符，但没有上游原始响应体，仍不能断言具体转换代码或命中的渠道。

### 当前结论更新

**已验证的边界（9/19 修正措辞）：** 已捕获的攻击检测开关对照未改变工具定义；所查四个晚间样本没有超管提示且权限正常；异常文字已存在于 CLI 原始记录而非仅在 renderer 中产生；CLI 并非 9/18 当天刚升级。有限成功样本不能彻底排除间歇性交互，不能笼统写成“已排除所有相关功能”。  
**最强嫌疑：** `api.mouxihub.com` 某个间歇性转接渠道对 Codex Responses 新版 `additional_tools` namespace 与 `custom_tool_call` 的兼容/转换不稳定；异常时可能只保留旧式 JSON `function_call` 或普通 `message`。  
**尚未证实：** 具体渠道、底层模型映射、是否丢失/改写了 `custom_tool_call` 输入，以及为何同会话续发会恢复。需要服务商按上述请求编号查看服务端入站/出站日志。

## 2026-09-19 凌晨追加：同轮中途异常，父子线程接近同时受影响

### 原始记录复核

只读核查 9/19 新建的 57 份 rollout，按根记录 `type` / `payload` 解析，排除 user 粘贴历史及工具输出中的引用。两个新 assistant 消息均位于 TaleCity，CLI 仍为 `0.153.4`。不将复制的父线程历史计为子线程新事件，不以文件最后一条 `session_meta` 覆盖该文件第一条本体元数据。

- 根线程：`01a0b567-db1d-74e1-a759-23d8258471be`，用户回合 `01a0b567-dbd6-75e2-a6f6-ad54e6224092`。
- 子线程：`01a0b56b-3dbb-7431-bc3f-5836d80df2fb`，子回合 `01a0b56b-3f36-70e0-b6ed-1b42d343c865`。
- **根线程 00:44–00:49 已执行 9 次真正的 `exec` 调用；子线程 00:48–00:49 已执行 7 次。** 两者随后转为 `item_* function_call` 的代理通信/等待工具，最后分别于 00:51:24、00:50:25 明确声称文件/命令工具不可用，并记录 `task_complete`。不是两次新建会话首轮初始化失败。
- 根线程同一用户回合内还出现过 `ctc_* → item_* → ctc_* → item_*` 交替；在其 00:44:37 开始至 00:51:24 完成之间，没有新的用户回合开始。最后一句“本轮没有落地修复”是模型自述，不代表此前未执行工具，也不能作为本地权限事实。
- 日志中每次采样都直连 `https://api.mouxihub.com/v1/responses`。输出类型来自 CLI 对上游 item 的记录，不是由 Chill Vibe 前端生成。**`function_call` 和 `message` 本身是合法输出，不是协议错误；`item_` 前缀只是相关线索，不能据此判定工具被降级、模型被替换或自动重试。** 没有失败请求体，因此仍不能证明上游具体在哪一步删除或改写工具。

北京时间（UTC+8）与可核查编号：

| 对照 | HTTP 日志时间 | 请求编号 | 随后输出 |
| --- | --- | --- | --- |
| 根线程末次正常命令采样 | 9/19 00:49:37 | `MC202609181649289520574148268d9d6msWHWC8e` | `ctc_* custom_tool_call: exec` |
| 根线程随后采样 | 9/19 00:50:03 | `MC202609181649497262375738268d9d6SAQA0sm0` | `item_* function_call: list_agents` |
| 根线程异常结束 | 9/19 00:51:19 | `MC202609181651043972871518268d9d6Y9oFGjlM` | “没有可用的文件读写、命令执行工具” |
| 子线程末次正常命令采样 | 9/19 00:49:35 | `MC202609181649316047867968268d9d6iohcl1lk` | `ctc_* custom_tool_call: exec` |
| 子线程异常结束 | 9/19 00:50:21 | `MC202609181650134617078278268d9d6IhKsNBRL` | “文件编辑和命令执行工具不可用” |

### 新探针与复现限制

01:36–01:37 再跑 12 次真实 `launchProviderRun` 隔离探针，攻击检测开/关各 6 次，12 次均 HTTP 200 且返回 `custom_tool_call: exec`，工具哈希仍为 `f0540ca7f9361886be964e46f59d21acc3fca4807aeb9e7b639db617bdde0fd1`。未执行这些回包中的命令、未重发用户业务消息。请求仅为短合成测试，不能替代长历史/多代理业务请求的失败抓包。

证据保存在本地忽略目录 `.chill-vibe/tool-investigation/capture-1789752993470/`（12 对请求/响应、汇总 JSON）与 `timeline-0919.json`（按 thread/time 索引只读查询的脱敏元数据）。脚本已改为每次独立输出目录，避免覆盖旧样本；正常退出删除临时认证及配置文件。未保存认证头。仅工具/文档取证，无产品行为变更，沿用当前 SPEC，不打包、不重启发布版。

下一步要区分的是：同样声明了 `functions.exec` 的失败请求是否在转接后仍保留它，以及成功/异常采样是否命中了不同渠道。服务商可直接按上述“相邻成功＋失败”编号核对；在客户端捕获失败之前，不修改生产协议、不关闭防护、不根据自然语言失败自述无限重跑。

## 2026-09-19 01:45–01:48：长度/图片矩阵，以及遗漏的协议错误

### 隔离矩阵

本轮不再只重复短提示。相同 `launchProviderRun`、CLI、模型和开启的防护下，分别做短文本、短文本＋合成 PNG、长文本、长文本＋合成 PNG，各 2 次，共 8 次；长输入只含确定生成的无业务含义记录，图片为本地生成的 256×256 色块，不读取用户图片或重放业务任务。

| 条件 | 上游报告 input tokens | 次数 | 结果 |
| --- | --- | --- | --- |
| 短文本 | 7248 | 2 | 真正 `custom_tool_call: exec` |
| 短文本＋图片 | 7389 | 2 | 真正 `custom_tool_call: exec` |
| 长文本 | 95124 | 2 | 真正 `custom_tool_call: exec` |
| 长文本＋图片 | 95265 | 2 | 真正 `custom_tool_call: exec` |

8 次 HTTP 均为 200，工具哈希均与前轮相同。直接解析保存的原始 SSE 验证：每条文本/工具参数增量对应已出现的 `response.output_item.added`，每份含一个 `response.completed`。不是仅凭模型说自己有工具判成功。

证据目录 `.chill-vibe/tool-investigation/capture-1789753560631/`；`verify-matrix.mjs` 自动核验原始请求中的图片数量、工具定义哈希、返回工具事件、流事件先后和临时认证文件清理，8/8 通过。**这只能说明长度约 9.5 万 token 与普通图片不是稳定触发器；不能替代真实历史、工具返回图片、重试后请求或上游渠道的对照。** 所有模型命令仍截断未执行。

### 新的直接故障证据

重新只读查询 CLI SQLite 的 `thread_id` 和时间索引，发现前轮时间线只提取 HTTP/item，漏掉了重要的 WARN/ERROR。根线程 `01a0b567…`：

1. **00:46:29**，HTTP 200 请求 `MC202609181646259516005488268d9d6EcfCZN7N` 后，日志 **75641891** 报 `OutputTextDelta without active item`。即文本增量到来时 CLI 没有可匹配的活动输出项。
2. **00:47:34**，日志 **75642358** 报 `stream closed before response.completed`，并进行原生采样重试 `1/5`。这发生在 CLI 内部，不是 Chill Vibe 重启/新建用户回合。
3. **00:47:46**，重试请求 `MC202609181647371963478358268d9d6Rd7vYYsj` 返回 `item_* reasoning/function_call`；后续又恢复过真正 `exec`，最终 00:51:24 才声称工具不可用。
4. 同一根回合另外有 **4 条**相同解析错误；子线程 `01a0b56b…` 有 **6 条**。部分错误紧随正常 `ctc_*` 工具输出所在响应出现，因此不能把该报错当成“所有工具都没了”的充分条件。

此样本把问题从纯粹的“模型说没有工具”推进到**已观察到 CLI 接收上游流时有解析异常和缺失完成事件**。但尚无失败原始 SSE，无法区分上游缺少/错序事件、兼容心跳或 CLI 解析缺陷，也不能证明它导致随后的工具能力否认。

反例检查：截图护盾线程 `01a0b504…` 按 thread 索引未找到上述解析/断流错误，仍不能把所有截图归成同一个已证原因。错误元数据保存在 `errors-0919.json`、`retry-errors-comparison.json`；没有复制推理正文或认证头。

本轮仅完善本地诊断与调查文档；按现有 stream-recovery-feedback SPEC 的完成边界工作，不新建产品 SPEC、不修改运行逻辑或防护、不构建或重启用户发布版。重复成功采样不能修复故障；下一条高价值证据是上述缺事件请求的上游原始 SSE 及重试前后工具定义，而不是继续无界扩大同类短探针数量。

## 2026-09-19 02:01–02:09：实际执行、多轮状态、工具图片与合成故障注入

按用户“自己想办法测”的要求，新建临时 HOME/空工作区，用同一 CLI、模型与服务商启动真实 app-server，复用 `prepareCodexSafetyRuntime`、`ensureCodexSafetyHookTrusted`，隔离 HOME、删除保护、攻击检测均开启。不再只截取首包：允许逐字白名单的 `functions.exec` 真正执行 `Write-Output`，图片测试仅允许读取探针生成的 PNG。非白名单调用立即终止测试进程，不把它当产品故障。

| 测试 | 用户回合 / HTTP 请求 | 实际命令结果 | 本地证据目录（tool-investigation 下） |
| --- | --- | --- | --- |
| 同线程连续执行，短输出/300 次字符串交替 | 16 / 32 | 16 次 exit 0 | `multi-1789754474847` |
| 工具读取并返回图片，随后继续执行 | 6 / 12 | 6 次 exit 0；3 张工具结果图片进入后续请求 | `multi-1789754687461` |
| 第二轮最终答复移除 `response.completed`，仅注入一次 | 6 / 13 | 6 次 exit 0；额外采样成功，命令未重复执行 | `multi-1789754711116` |
| 第二轮最终答复前插入无对应 item 的文本 delta，仅注入一次 | 4 / 8 | 4 次 exit 0；出现真实 CLI 解析报错，后续仍能执行 | `multi-1789754785558` |
| 只发一次任务，中途连续调用 12 次工具，交替返回图片 | 1 / 13 | 12 次 exit 0；6 张工具结果图片进入同一回合后续请求 | `multi-1789754871100` |

合计 **33 个用户回合、78 次 HTTP 请求、44 次实际命令执行**。每一份请求均包含 `functions.exec`，后续采样保留真实 `custom_tool_call_output`；没有出现“无文件/命令工具”。最后一项专门避免每轮用户重新点名工具对测试结果的影响，但仍使用了明确的初始工具提示，不能代表自然业务提示。

### 真正新增的因果证据

- 孤立 delta 注入于 02:06:44 使 CLI stderr **确实出现 `OutputTextDelta without active item`**，随后第 3、4 轮继续正常执行。此为合成故障，不是抓到了自然失败上游响应；它证明该报错本身不充分导致工具消失，不能再把它直接当根因。
- 移除完成事件后，同一第 2 轮从通常 2 次采样增为 3 次；额外请求仍带完整工具定义，返回 DONE，之后 4 轮均执行成功。对应原始上游包本来完整，只改交给临时 CLI 的副本，`3-response.txt` 与 `3-delivered.txt` 分开保存。
- 工具哈希并非全程相同：首包 `f0540c…`，首次执行后变为 `1122c9…`，此后稳定。逐字段比对仅 `functions.exec.description` 新增 deferred-tools 说明与 Shared MCP Types，原有 shell/文件说明没有删掉。不能把这次哈希变化说成工具丢失或错误归因为 cwd；已加入 AGENTS.md 取证陷阱。

### 验证与限制

`verify-multiturn.mjs` 从保存的原始请求/SSE 独立核验工具定义、哈希、增量生命周期、原始完成事件、命令退出码、图片进入后续请求、重试额外采样与临时认证文件清理；五组均通过。`probe-multiturn.mjs` 与验证脚本通过 Node 语法检查。

多轮脚本直接使用 app-server 和安全准备函数，**不是完整 Chill Vibe UI/launchProviderRun 路径**；本地安全代理先缓冲整份 SSE、校验白名单后再转发，因此改变实时分块与时间分布。不能据此排除 UI、流时序、复杂业务历史、多代理并发或间歇性渠道问题。前面的 `launchProviderRun` A/B 和矩阵是另一组证据，不混称为本组覆盖。

本轮缩小了“单纯图片/续聊/该解析报错/缺结束事件就会稳定丢工具”的假设范围，**没有自然复现，也没有确认或修复产品根因**。保留现有防护和路由，不增加自然语言触发的自动重发，不重放业务任务。仅本地诊断工具和文档变更，沿用现有 SPEC、免新 SPEC/打包/运行时重启；未停止用户发布版。

## 2026-09-19 10:47–10:50：真实启动路径续聊与自然异常心跳

`probe-launch-multiturn.mjs` 调用真实 `launchProviderRun`，通过 `sessionId` 恢复同一原生线程 `01a0b78f-68ac-7272-b014-5c46f6ae55b9`，开启隔离 HOME、删除保护和攻击检测。8 轮交替执行固定命令及读取合成图片；所有模型工具调用仍经逐字白名单验证后放行。证据在 `.chill-vibe/tool-investigation/launch-1789786023472/`。时间为北京时间，日志 ISO 时间为 UTC。

- 18 次 HTTP 请求，16 次 200、2 次 503；8 次命令结果均 exit 0 且输出 `TOOL_PROBE_OK`，4 次工具图片真实进入后续请求。每份请求包含 `functions.exec`，8 轮使用相同原生线程；临时认证与配置已删除。
- 第 4 轮两次 503 返回“系统繁忙，请稍后再试”，第 3 次采样成功。原始请求 `6/7/8-request.json` 逐字一致，重试没有丢失工具或上下文，且该轮只执行一次命令。503 不是此次“无工具”复现。
- **自然上游协议异常已捕获：** 请求 `MC202609190249243565167998268d9d6i8TtL10B`（本地序号 12，第 6 轮）在原始 SSE 中返回 `{"type":"response.output_text.delta","item_id":"SSE-Keep-Alive","output_index":0,"content_index":0,"delta":"","SSE-Keep-Alive":true}`，此前没有该 item 的 `response.output_item.added`。这不是本地故障注入；本地代理保存上游正文后原样转发。
- 临时 CLI 日志 571 在 10:49:48 报 `OutputTextDelta without active item`，已保存脱敏查询结果 `protocol-errors.json`。因此本样本可把**这一条解析错误**定位到服务商回包中的伪正文心跳。不能把此结论推广到未抓包的所有历史解析错误。
- 第 6 轮自身及第 7、8 轮仍成功执行工具，故该心跳/解析报错仍不是“无文件、命令工具”的充分根因。真实“无工具”失败请求仍未捕获；此前报告中的这一限制继续有效。

`verify-launch-multiturn.mjs` 独立读取原始请求/SSE，检查命令调用与返回配对、退出码、图片、线程恢复、重试请求一致性和认证清理；命令检查通过。协议检查发现上述孤立增量，脚本明确输出 `protocolChecksPassed=false` 并以 2 退出，不能把整组写成全绿。探针与验证脚本均通过 Node 语法检查。

六组实际执行测试累计 96 次请求、52 次成功命令执行；这不包含此前仅截断响应的探针。完整 UI、实时 SSE 分块、多代理并发和真实业务历史仍未被此白名单缓冲探针覆盖。仅更新本地诊断及文档，沿用现有 SPEC 和原生完成边界，不修改生产协议或用户设置、不打包或重启发布版。
