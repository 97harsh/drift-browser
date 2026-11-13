const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/main/pagescripts');

test('injected scripts are valid JavaScript', () => {
  for (const code of [s.PIP, s.HAS_PLAYING_VIDEO, s.MEDIA_TOGGLE, s.readPage(100), s.locate({ index: 1 }), s.jsClick({ selector: 'a' }),
    s.focusForTyping({ index: 2 }, true), s.scroll('down', 0), s.waitFor('#x', 10), s.describe({ active: true }), s.extractProducts(5)]) {
    assert.doesNotThrow(() => new Function(code), code.slice(0, 80));
  }
});

test('selectors are JSON-escaped, not interpolated raw', () => {
  const code = s.locate({ selector: '"]); alert(1); (["' });
  assert.ok(code.includes(JSON.stringify({ selector: '"]); alert(1); (["' })));
});
