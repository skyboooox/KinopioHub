import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pages, renderPages, run } from './wiki.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kinopio-wiki-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const source of Object.keys(pages)) {
    await fs.mkdir(path.dirname(path.join(root, source)), { recursive: true });
    await fs.writeFile(path.join(root, source), '# Page\n');
  }
  await fs.writeFile(path.join(root, 'repositories.json'), '{}');
  return root;
}

test('mapped pages, anchors, reference links, and assets rewrite while code remains literal', async t => {
  const root = await fixture(t);
  const code = '```md\n[example](../../private.md)\n```\n~~~\n[example](missing.md)\n~~~';
  await fs.writeFile(path.join(root, 'docs/wiki-home.md'), `[SDK](javascript.md#basic-api)\n[manifest](../repositories.json)\n[ref]: architecture.md "Architecture"\n[external](https://example.com/a)\n[local](#page)\n\`[inline](missing.md)\`\n${code}\n`);
  const rendered = await renderPages(root), home = rendered.get('Home-ZH.md');
  assert.match(home, /wiki\/JavaScript#basic-api/);
  assert.match(home, /blob\/main\/repositories.json/);
  assert.match(home, /\[ref\]: https:\/\/github.com\/skyboooox\/KinopioHub\/wiki\/Architecture "Architecture"/);
  assert.ok(home.includes(code)); assert.ok(home.includes('`[inline](missing.md)`'));
  assert.ok(home.includes('[local](#page)')); assert.ok(home.includes('[external](https://example.com/a)'));
  assert.equal(rendered.size, Object.keys(pages).length + 2);
  assert.deepEqual(await renderPages(root), rendered);
});

test('build/check detects stale sources and preserves unrelated output', async t => {
  const root = await fixture(t), output = path.join(root, '.wiki');
  await run({ root }); await fs.writeFile(path.join(output, 'notes.txt'), 'keep');
  await run({ root, check: true });
  await fs.appendFile(path.join(root, 'docs/javascript.md'), 'Changed\n');
  await assert.rejects(run({ root, check: true }), /stale/);
  await run({ root }); await run({ root, check: true });
  assert.equal(await fs.readFile(path.join(output, 'notes.txt'), 'utf8'), 'keep');
});

test('missing links, path escapes, and source symlinks are rejected', async t => {
  const root = await fixture(t), home = path.join(root, 'docs/wiki-home.md');
  for (const [link, error] of [['missing.md', /Missing link/], ['../../private.md', /escapes repository/], ['..%2F..%2Fprivate.md', /escapes repository/]]) {
    await fs.writeFile(home, `[bad](${link})`); await assert.rejects(renderPages(root), error);
  }
  await fs.unlink(home); await fs.symlink(path.join(os.tmpdir()), home);
  await assert.rejects(renderPages(root), /Source escapes repository/);
});

test('output refuses user-authored files or symlinks without partial writes', async t => {
  const root = await fixture(t), output = path.join(root, 'custom'); await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'Home.md'), 'User content');
  await assert.rejects(run({ root, output }), /non-generated/);
  assert.equal(await fs.readFile(path.join(output, 'Home.md'), 'utf8'), 'User content');
  assert.deepEqual(await fs.readdir(output), ['Home.md']);
  await fs.unlink(path.join(output, 'Home.md'));
  await fs.symlink(path.join(root, 'repositories.json'), path.join(output, 'Home.md'));
  await assert.rejects(run({ root, output }), /not a regular file/);
});


test('both languages map to stable distinct Wiki destinations with language switches', async t => {
  const root = await fixture(t);
  const topics = ['JavaScript', 'Python', 'Cpp', 'Arduino', 'ROS', 'Web', 'Server', 'Architecture', 'Development', 'Variables', 'Messaging', 'Networking', 'Troubleshooting', 'JavaScript-API', 'Python-API', 'Cpp-API', 'Arduino-API', 'ROS-Config'];
  assert.equal(pages['docs/wiki-home.md'], 'Home-ZH.md');
  assert.equal(pages['docs/wiki-home.en.md'], 'Home.md');
  assert.equal(new Set(Object.values(pages)).size, Object.keys(pages).length);
  for (const topic of topics) {
    const source = `docs/${topic.toLowerCase()}.md`;
    const chinese = source.replace(/\.md$/, '.zh.md');
    assert.equal(pages[source], `${topic}.md`);
    assert.equal(pages[chinese], `${topic}-ZH.md`);
    await fs.writeFile(path.join(root, source), `[中文](${path.basename(chinese)}#usage)\n`);
    await fs.writeFile(path.join(root, chinese), `[English](${path.basename(source)}#usage)\n`);
  }
  await fs.writeFile(path.join(root, 'docs/wiki-home.md'), '[English](wiki-home.en.md)\n');
  await fs.writeFile(path.join(root, 'docs/wiki-home.en.md'), '[中文](wiki-home.md)\n');
  const rendered = await renderPages(root);
  for (const topic of topics) {
    assert.ok(rendered.get(`${topic}.md`).includes(`/wiki/${topic}-ZH#usage`));
    assert.ok(rendered.get(`${topic}-ZH.md`).includes(`/wiki/${topic}#usage`));
  }
  assert.ok(rendered.get('Home.md').includes('/wiki/Home-ZH'));
  assert.ok(rendered.get('Home-ZH.md').includes('/wiki/Home)'));
  assert.ok(rendered.get('Home-EN.md').includes('/wiki/Home)'));
  assert.ok(rendered.get('_Footer.md').indexOf('[Home]') < rendered.get('_Footer.md').indexOf('[简体中文]'));
  assert.ok(rendered.get('_Footer.md').includes('/wiki/Development-ZH#github-wiki'));
  assert.ok(rendered.get('_Footer.md').includes('/wiki/Development#github-wiki'));
});

test('only explicitly allowlisted sources become Wiki pages', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'docs/private.md'), '# Private scratch document');
  const rendered = await renderPages(root);
  assert.equal(rendered.size, Object.keys(pages).length + 2);
  assert.ok(![...rendered.values()].some(content => content.includes('Private scratch document')));
});

test('retired generated pages are removed without deleting unrelated or authored pages', async t => {
  const root = await fixture(t), output = path.join(root, '.wiki');
  await run({ root });
  const generated = await fs.readFile(path.join(output, 'Home.md'), 'utf8');
  await fs.writeFile(path.join(output, 'Origins.md'), generated);
  await fs.writeFile(path.join(output, 'Personal.md'), 'Keep this page');
  await assert.rejects(run({ root, check: true }), /Retired Wiki page/);
  await run({ root });
  await assert.rejects(fs.access(path.join(output, 'Origins.md')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(output, 'Personal.md'), 'utf8'), 'Keep this page');
  await fs.writeFile(path.join(output, 'Origins.md'), generated);
  await fs.writeFile(path.join(output, 'Compatibility.md'), 'Authored content');
  await assert.rejects(run({ root }), /non-generated/);
  assert.equal(await fs.readFile(path.join(output, 'Origins.md'), 'utf8'), generated);
  assert.equal(await fs.readFile(path.join(output, 'Compatibility.md'), 'utf8'), 'Authored content');
});
