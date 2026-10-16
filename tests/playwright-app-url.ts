// Playwright 不用 `pnpm dev` 的 5173：2026-10-16 发版门禁里，另一个项目的 Vite 占着 [::1]:5173，
// spec 里的 localhost:5173 解析到它，主题门禁整片打到别人的页面上。独立端口 + 写死 127.0.0.1，
// 和开发服务器、其他 checkout 都互不抢；要并跑多份可用 PW_PORT 错开。
export const playwrightPort = Number(process.env.PW_PORT ?? 5199)

export const appUrl = process.env.PLAYWRIGHT_APP_URL ?? `http://127.0.0.1:${playwrightPort}`
