# Web console

[简体中文](web.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.web)

The Web console is a browser client for KinopioHub cloud variables and NATS messages. It joins the namespace selected for the console, so use the same namespace as the devices and services that should exchange data. A namespace organizes shared data; it is not an authorization boundary.

Browsers connect only through a reachable WS/WSS client endpoint. They do not host or elect a broker. See the [JavaScript API](javascript-api.md), [variables](variables.md), [events and requests](messaging.md), and [networking](networking.md) for the shared contract.

## Run locally

In `KinopioHub.web`:

```sh
npm install
npm run dev
```

Open the URL printed by Vite and configure a reachable WS/WSS client endpoint. Browser access from an HTTPS page requires WSS with a trusted certificate. A request needs an application responder for its subject; its response represents the completion rule implemented by that responder.

> **Note:** Cloud variables hold current RAM values, not history or durable commands. `set()` updates local RAM, and `flush()` confirms NATS transport; neither confirms that a device applied a requested action. Use an application response or reported value when execution confirmation matters. Events are transient: they are not buffered offline or replayed.

> **Note:** Connection profiles and UI preferences are stored locally in the browser. Shared links carry non-secret connection/UI settings; do not put tokens, passwords or credential files in a URL.

## Build and deploy

```sh
npm run typecheck
npm run build
npm run preview
```

Deploy `dist/` with a static web server. Configure SPA fallback to `index.html`; avoid long caching of that file and cache hashed assets normally. Existing Caddy deployment files are environment-specific examples, not public test endpoints.

Font assets live in `public/fonts/`; check their distribution terms before republishing them.
