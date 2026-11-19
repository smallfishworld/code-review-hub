# codereview-hub Web 控制台

基于 React 19 + TypeScript + Vite 的单页应用，由服务端（`server/`）直接托管构建产物（`web/dist/`）。

## 开发

```bash
npm --prefix web run dev     # Vite 开发服务器 :5173，/api 代理到后端 :3000
npm --prefix web run build   # 类型检查 + 产物构建
npm --prefix web run lint    # ESLint
```

页面源码位于 `web/src/pages/`（仓库 / 监控 / 触发 / 任务 / Provider / 通知 / 设置），API 客户端位于 `web/src/api/client.ts`。主题 token（浅色 / 深色）定义在 `web/src/index.css`。
