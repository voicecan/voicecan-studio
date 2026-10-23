import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderStudioPage, STUDIO_PAGE } from '../dist/studio-page.js';
import { studioLocale } from '../dist/studio-i18n.js';
import { createStudioServer } from '../dist/web.js';

function browser(locale = 'en', { saved, blockedStorage = false, query = '' } = {}) {
  const nodes = new Map();
  const storage = new Map(saved ? [['studio.locale', saved]] : []);
  const location = { href: `http://studio.test/${query}`, replace(url) { this.redirect = url; }, assign(url) { this.navigation = url; } };
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', innerHTML: '', classList: { toggle() {}, add() {} } });
    return nodes.get(selector);
  }, querySelectorAll: () => [] };
  const context = vm.createContext({ document, location, URL, Intl, console,
    localStorage: { getItem(key) { if (blockedStorage) throw new Error('blocked'); return storage.get(key); }, setItem(key, value) { if (blockedStorage) throw new Error('blocked'); storage.set(key, value); } },
    sessionStorage: { getItem: () => null }, fetch: () => new Promise(() => {}),
    setInterval() {}, setTimeout() {}, clearTimeout() {}, confirm: () => false,
  });
  const script = renderStudioPage(locale).match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  return { context, nodes, storage, location };
}

test('English is the HTTP default; Chinese is explicit and unknown locales fall back to English', async (context) => {
  const server = createStudioServer({});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const query of ['', '?lang=fr', '?lang=zh-CN']) {
    const page = await (await fetch(origin + '/' + query)).text();
    const chinese = query === '?lang=zh-CN';
    assert.match(page, chinese ? /<html lang="zh-CN">/ : /<html lang="en">/);
    assert.ok(page.includes(chinese ? 'placeholder="搜索录音、场景或内容"' : 'placeholder="Search recordings, scenarios or content"'));
  }
  assert.equal(studioLocale(null), 'en');
  assert.equal(STUDIO_PAGE, renderStudioPage('en'));
});

test('language selection persists, restores on later visits and handles unavailable storage', () => {
  const first = browser();
  assert.equal(first.nodes.get('#language').value, 'en');
  first.nodes.get('#language').value = 'zh-CN';
  first.nodes.get('#language').onchange();
  assert.equal(first.storage.get('studio.locale'), 'zh-CN');
  assert.equal(first.location.navigation, 'http://studio.test/?lang=zh-CN');
  assert.equal(browser('en', { saved: 'zh-CN' }).location.redirect, 'http://studio.test/?lang=zh-CN');
  assert.equal(browser('en', { saved: 'zh-CN', query: '?lang=en' }).location.redirect, undefined);
  const blocked = browser('en', { blockedStorage: true });
  blocked.nodes.get('#language').value = 'zh-CN';
  assert.doesNotThrow(() => blocked.nodes.get('#language').onchange());
  assert.equal(blocked.location.navigation, 'http://studio.test/?lang=zh-CN');
});

test('switching language can be canceled while editing', () => {
  const page = browser();
  vm.runInContext('editing=true', page.context);
  page.nodes.get('#language').value = 'zh-CN';
  page.nodes.get('#language').onchange();
  assert.equal(page.nodes.get('#language').value, 'en');
  assert.equal(page.location.navigation, undefined);
});

test('dynamic UI metadata is localized while transcript and generated content stay unchanged', () => {
  const { context } = browser();
  vm.runInContext(`scenarios=[{id:'voice-inbox',title:'语音收件箱',fields:[{key:'tags',label:'标签'}]}]`, context);
  assert.equal(vm.runInContext("scenarioTitle('voice-inbox')", context), 'Voice Inbox');
  assert.equal(vm.runInContext("fieldLabel('voice-inbox','tags')", context), 'Tags');
  assert.equal(vm.runInContext("stateLabel('skipped')", context), 'Skipped');
  const html = vm.runInContext(`summaryCopy({title:'会议 / 访谈',overview:'保留原文 <script>',topics:[],decisions:[],action_items:[]})`, context);
  assert.ok(html.includes('<h4>会议 / 访谈</h4>'));
  assert.ok(html.includes('保留原文 &lt;script&gt;'));
  assert.ok(html.includes('<h4>Action items</h4>'));
  assert.match(vm.runInContext("transcriptStage({playback_ready:false,transcript:null})", context), /Save transcript/);
  vm.runInContext('renderSetup()', context);
  assert.match(context.document.querySelector('#workspace').innerHTML, /Speech recognition URL/);
  const chinese = browser('zh-CN');
  assert.equal(vm.runInContext("stateLabel('skipped')", chinese.context), '已跳过');
});
