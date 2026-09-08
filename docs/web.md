# Web console

[简体中文](web.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.web)

The current console uses `kinopio-hub` 2.x. It can observe NATS subjects and send request/reply messages, but it is not yet a v3 cloud-variable or SDK-health dashboard. It cannot be used as a v3 ROS live controller.

## Run locally

In `KinopioHub.web`:

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Configure a reachable WS/WSS client endpoint, connect, then enter the subject to watch. Request/reply needs a responder for the requested subject. Browser access from an HTTPS page requires WSS with a trusted certificate.

Connection profiles and UI preferences are stored locally in the browser. Shared links carry non-secret connection/UI settings; do not put tokens, passwords or credential files in a URL.

## Build and deploy

```sh
npm run typecheck
npm run build
npm run preview
```

Deploy `dist/` with a static web server. Configure SPA fallback to `index.html`; avoid long caching of that file and cache hashed assets normally. Existing Caddy deployment files are environment-specific examples, not public test endpoints.

The interface uses a subject watch list, server settings and a request panel. Font assets live in `public/fonts/`; check their distribution terms before republishing them. Avoid rebuilding the UI solely to change the documentation layout.

## Next step

Migrate to the v3 JavaScript SDK, then expose variable references, SDK instance status and clear desired/reported state. Keep old request/reply behavior separate from v3 live controls. This is planned work, not current functionality.
