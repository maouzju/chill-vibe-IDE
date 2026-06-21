# 字体设置设计

## 数据
在 `AppSettings` 增加 `fontFamily` 字段，使用受控字符串枚举，避免持久化任意 CSS。

## 字体选项
共享常量按用户常见心智排序：
- `default`：当前字体栈，置顶。
- `system`：系统无衬线。
- 常见无衬线：Aptos、Segoe UI、Arial、Microsoft YaHei / 微软雅黑、DengXian / 等线。
- 常见中文字体：SimSun / 宋体、SimHei / 黑体、KaiTi / 楷体、FangSong / 仿宋。
- 常见衬线：Serif、Georgia、Times New Roman。
- 常见等宽：Monospace、Cascadia Code、Consolas。

## 渲染
`App.tsx` 根据 `settings.fontFamily` 解析 CSS 字体栈，并写入 `:root` 的 `font-family` 和 Primer `--BaseStyles-fontFamily`，与现有 `fontScale` / `lineHeightScale` 同一路径即时生效。

## 设置界面
在外观设置的字体下拉下方提供一张轻量预览卡，同时展示中文、英文、数字和易混字符。预览卡只使用现有面板/边线 token，不新增强装饰 chrome。
