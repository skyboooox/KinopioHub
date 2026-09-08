# Web 控制台

[English](web.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.web)

当前控制台使用 `kinopio-hub` 2.x，可以观察 NATS subject 和发送 request/reply。它尚未迁移为 v3 云变量与 SDK 状态面板，也不能作为 v3 ROS 实时控制器。

## 本地运行

在 `KinopioHub.web` 中执行：

```sh
npm install
npm run dev
```

打开 Vite 打印的地址，配置可达的 WS/WSS 客户端入口，连接后输入要观察的 subject。request/reply 需要对应 subject 上存在响应者。HTTPS 页面需要使用证书受信任的 WSS 入口。

连接配置与界面偏好保存在浏览器本地。分享链接只携带非敏感的连接和界面设置；不要把 token、密码或凭证文件放入 URL。

## 构建与部署

```sh
npm run typecheck
npm run build
npm run preview
```

将 `dist/` 交给静态服务器。配置回退到 `index.html` 的 SPA 路由；不要长期缓存该文件，带哈希的静态资源可以正常缓存。仓库内已有的 Caddy 部署文件属于特定环境示例，不是公共测试入口。

界面由 subject 观察列表、服务器设置和 request 面板组成。字体资源位于 `public/fonts/`，再次分发前核对其授权。本次文档整理不改变界面实现。

## 下一步

迁移到 v3 JavaScript SDK，再提供变量引用、SDK 实例状态和明确的期望/报告状态。旧 request/reply 与 v3 live 控制需要区分；这些仍是计划，不是已实现功能。
