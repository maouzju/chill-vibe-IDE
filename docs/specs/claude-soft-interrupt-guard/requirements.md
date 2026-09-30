# Claude 常驻会话软中断保护需求

## 目标

修复 Claude 常驻会话中「点继续后很快又被停下」的竞态，同时保留真正的用户停止、自动恢复和排队发送行为。

## 需求

1. 每个常驻进程轮次拥有单调递增序号；停止请求只能作用于发起它的轮次。
2. 迟到、重复或已过期的 stop 不得向下一轮写入 interrupt，也不得误杀已复用的进程。
3. 第一次 stop 决定软中断或硬杀路径；重复 stop 幂等，不改变最终 stopped/interrupted 语义。
4. 自发轮次的过期 stop 只记录诊断并保持会话，不清除可恢复 session。
5. 渲染端在卡片已经 streaming 时，普通用户空「继续」不应把新轮次当成待打断轮次；有内容、答 ask-user、明确 interrupt/defer 和自动化入口保持原行为。
6. stop 来源、轮次、年龄和兜底路径写入服务端诊断日志，便于区分用户点击与 CLI 自发中止。

## 范围外

CLI 自身内部中断行为不在本次修复范围；探针仅作为取证工具，不作为运行时依赖。

## 验证

覆盖 ClaudeSessionPool 轮次守卫、ChatManager stop 幂等/自发轮次、渲染空继续守卫以及 desktop bridge origin 透传；`pnpm test` 与 release gate 负责整体验证。