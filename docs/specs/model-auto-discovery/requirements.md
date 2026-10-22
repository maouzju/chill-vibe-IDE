# 新模型自动发现 — Requirements

## 背景
用户 09-02 ~ 10-14 五次一句话要求「X 出了 跟进下」（Fable 5.1 / Sonnet 5.5 / Haiku 5.5 / GPT-6.1 Sol / Gemini 4）。
模型目录写死在 `shared/models.ts`，每出一个型号都要改代码发版，用户才能在下拉里选到。

## 需求
1. 应用启动就绪后，后台向当前实际使用的端点问一次「有哪些模型」（Claude: `GET /v1/models`；Codex: `GET <base>/models`；Gemini 仅在应用内接口配置填了 key 时问）。
2. 端点与密钥的来源与 CLI 实际使用的一致：应用内「接口配置」开着且有 key → 用它；否则 Claude 读 `~/.claude/settings.json` 的 env（再退到进程环境），Codex 读 `~/.codex/config.toml` 当前 `model_provider` 的 `base_url` + `~/.codex/auth.json` / `env_key`。
3. 只提示**真正新**的型号：不在内置目录（含已下架）、不在用户自定义下拉项里、没被提示过；版本号必须比内置目录里同家族最新的还新；过滤 `-compact`、`auto-review`、embedding/tts/image 等非对话模型和带日期的快照别名。
4. 有新型号时弹一个小窗（不和引导 / 恢复 / 换代弹窗叠），每行「加入下拉」，底部「全部加入」「忽略」。加入 = 写进 `modelPickerCustomModels`（与设置 →「模型下拉菜单」同一份数据），显示名自动生成（`claude-opus-6` → `Opus 6`）。
5. 不论加入还是忽略，都记进已提示名单，同一个型号只问一次；之后在设置里删掉该自定义项也不再弹。
6. 失败静默：端点不支持、超时（10s）、没配 key 都不打扰用户，只写服务端日志。密钥永不返回给渲染进程。

## 不做
- 不自动改默认模型（换代提示 `model-upgrade-prompt` 管这件事）。
- 不把发现的型号塞进子 agent 目录 / 超管目录（那两处只认内置目录，pitfall agent-model-choice）。
