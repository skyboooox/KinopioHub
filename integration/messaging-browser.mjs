import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
const require = createRequire(new URL('../../KinopioHub.JS/package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');

export async function browserPeer(options) {
  const bundle = await build({ stdin: { contents: `import Hub from '../../KinopioHub.JS/src/browser.mjs';
    import { sdkPeer } from './messaging-sdk-peer.mjs'; globalThis.start = ({ namespace, ...options }) => sdkPeer(new Hub(namespace, options));`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)) }, bundle: true, platform: 'browser', format: 'esm', write: false });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/sdk.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/sdk.js' ? bundle.outputFiles[0].text : '<!doctype html><title>Messaging fixture</title><script type="module" src="/sdk.js"></script>');
  });
  let browser, page;
  async function close() {
    if (page && !page.isClosed()) await page.evaluate(() => globalThis.peer?.close()).catch(() => {});
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch(); page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => !!globalThis.start);
    await page.evaluate(options => { globalThis.peer = globalThis.start(options); }, options);
    return { async call(op, fields = {}) {
      const response = await page.evaluate(async ([op, fields]) => {
        try { return { result: await globalThis.peer.call(op, fields) }; }
        catch (error) { return { error: { code: error.code, message: error.message } }; }
      }, [op, fields]);
      if (response.error) throw Object.assign(Error(response.error.message), { code: response.error.code });
      return response.result;
    }, close };
  } catch (error) { await close(); throw error; }
}
