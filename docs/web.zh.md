# Web 控制台

[English](web.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.web)

Web 控制台是 KinopioHub 的浏览器客户端，用于云变量和 NATS 消息。它加入控制台选择的 namespace；要与设备和服务交换数据，应使用相同的 namespace。namespace 用于组织共享数据，不是权限边界。

浏览器只通过可达的 WS/WSS 客户端入口连接，不托管或选举 broker。共用合同见 [JavaScript API](javascript-api.zh.md)、[云变量](variables.zh.md)、[事件与请求](messaging.zh.md)和[组网](networking.zh.md)。

## 本地运行

在 `KinopioHub.web` 中执行：

```sh
npm install
npm run dev
```

打开 Vite 打印的地址，配置可达的 WS/WSS 客户端入口。HTTPS 页面需要使用证书受信任的 WSS 入口。请求需要对应 subject 上有应用响应者；响应代表该响应者实现的完成条件。

> **注意：** 云变量保存的是当前 RAM 值，不是历史或持久命令。`set()` 更新本地 RAM，`flush()` 确认 NATS 传输；两者都不确认设备已经执行请求的动作。需要执行确认时，应使用应用响应或上报值。事件是瞬态消息，不会在离线时缓存或重放。

> **注意：** 连接配置与界面偏好保存在浏览器本地。分享链接只携带非敏感的连接和界面设置；不要把 token、密码或凭证文件放入 URL。

## 构建与部署

```sh
npm run typecheck
npm run build
npm run preview
```

将 `dist/` 交给静态服务器。配置回退到 `index.html` 的 SPA 路由；不要长期缓存该文件，带哈希的静态资源可以正常缓存。仓库内已有的 Caddy 部署文件属于特定环境示例，不是公共测试入口。

字体资源位于 `public/fonts/`，再次分发前核对其授权。
