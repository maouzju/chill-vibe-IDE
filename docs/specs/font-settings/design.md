# 字体设置设计

## 数据
在 `AppSettings` 增加 `fontFamily` 字段，使用受控字符串枚举，避免持久化任意 CSS。

## 字体选项
新增共享常量：
- `default`：当前字体栈，置顶。
- `system`：系统无衬线。
- `serif`：衬线。
- `mono`：等宽。

## 渲染
`App.tsx` 根据 `settings.fontFamily` 解析 CSS 字体栈，并写入 `:root` 的 `font-family`，与现有 `fontScale` / `lineHeightScale` 同一路径即时生效。

## 设置界面
在外观设置的语言和主题之间加入一个普通 select。复用 `settings-field` 和 `settings-input`，不新增视觉 chrome。
