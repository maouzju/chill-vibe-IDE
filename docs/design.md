# Chill Vibe IDE 设计文档

## 1. 设计原则

### 1.1 Board First

界面不是“先进入项目，再进入会话”，而是直接进入看板。用户打开后看到的就是所有并行中的工作流。

### 1.2 Card Is Chat

每个卡片就是完整会话页面，不进入二级详情页，不做额外跳转。

### 1.3 Quiet UI

顶部工具条尽量收敛，控制按钮以图标为主，把注意力留给卡片正文和工作区配置。

### 1.4 Stretch With Work

聊天内容默认向下增长，卡片保留手动拉伸能力，用来调节最低可视高度，而不是把消息困在一个小滚动区里。

## 2. 信息架构

### 2.1 顶层结构

- 整个页面只有一个横向看板容器。
- 看板中是多个工作区列。
- 最右侧是一个加号占位列，用于新增列。

### 2.2 列结构

每一列包含：

- 拖拽手柄
- 列标题，以及 provider / workspace / model 摘要
- 设置、复制、新增卡片、删除等图标按钮
- 展开的工作区设置区
- 垂直堆叠的聊天卡片

### 2.3 卡片结构

每张卡片包含：

- 标题
- 会话状态与会话 ID 摘要
- 删除与拖拽图标
- 消息列表
- 输入区，以及发送 / 停止图标
- 底部拉伸手柄

## 3. 交互设计

### 3.1 列拖拽

- 通过列头手柄拖动
- 在目标列左半区或右半区落下
- 分别对应插入到目标列前后

### 3.2 卡片拖拽

- 通过卡片头部手柄拖动
- 可在同列内重排
- 可跨列移动
- 可拖到列底部空白处插入到末尾

### 3.3 卡片高度拉伸

- 卡片底部有专用拉伸手柄
- 用户拖动后改变卡片最小高度
- 内容超出时继续向下增长，而不是强制固定在内部滚动框

### 3.4 新增列

- 顶部新增按钮已移除
- 看板最右侧保留一个加号占位列
- 点击后复制最近一列的 provider / workspace / model 作为默认值

## 4. 视觉设计

### 4.1 总体方向

- 中性浅色底
- 柔和边框和阴影
- 明确的看板块状分组
- 少文案、少噪音、少装饰

### 4.2 图标策略

- 设置、复制、删除、发送、停止、新增、拖拽均使用图标按钮
- 文字保留给标题、路径和状态这类信息本体

### 4.3 状态反馈

- Ready：绿色弱强调
- Running：暖色弱强调
- Error：红色弱强调
- Drop 提示：目标边缘高亮

## 5. 数据模型

```ts
type Provider = 'codex' | 'claude'

type AppState = {
  version: 1
  columns: BoardColumn[]
  updatedAt: string
}

type BoardColumn = {
  id: string
  title: string
  provider: Provider
  workspacePath: string
  model: string
  cards: ChatCard[]
}

type ChatCard = {
  id: string
  title: string
  sessionId?: string
  status: 'idle' | 'streaming' | 'error'
  size?: number
  messages: ChatMessage[]
}
```

说明：

- `workspacePath` 决定 CLI 的工作目录
- `sessionId` 对应 provider 原生会话 ID
- `size` 表示卡片的最小高度

## 6. 技术设计

### 6.1 前端

- React 管理界面和交互
- 原生 HTML Drag and Drop 实现拖拽排序
- reducer 管理列和卡片状态
- 自动保存布局

### 6.2 后端

- Express 提供状态与会话 API
- 统一封装本地 Codex / Claude CLI
- 使用 SSE 将流式输出推给前端
- 当当前 provider 的本地 CLI 不可用时，聊天发送仍然要进入应用层校验，并在卡片内追加“本地 CLI 不可用”的系统提示；不能只禁用发送按钮让用户反复点击却没有反馈。

### 6.3 持久化

- 布局保存在 `.chill-vibe/state.json`
- 工作区配置、卡片顺序、消息历史一并保存

## 7. 已落地实现

- 看板式主界面
