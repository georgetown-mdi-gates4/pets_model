import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHistory, saveHistory, clearHistory } from '../public/history.mjs';
import { matchingWords, sourceNoteExcerpt } from '../public/evidence-notes.mjs';

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('chat history survives a reload and can be cleared locally', () => {
  const storage = memoryStorage();
  assert.equal(saveHistory(storage, { activeId: 'one', chats: [{
    id: 'one', title: 'Link records', updatedAt: '2026-11-03T00:00:00Z', profile: { goal: 'link' },
    mode: 'choose', lastTopicQuery: 'Link records', messages: [
      { role: 'user', text: 'Link records', sources: [] },
      { role: 'assistant', text: 'Consider PPRL.', sources: [{ id: 'nih-pprl-fuzzy', url: 'https://example.org' }] }
    ]
  }] }), true);
  const restored = loadHistory(storage);
  assert.equal(restored.activeId, 'one');
  assert.equal(restored.chats[0].messages[1].sources[0].id, 'nih-pprl-fuzzy');
  clearHistory(storage);
  assert.deepEqual(loadHistory(storage), { activeId: null, chats: [] });
});

test('corrupt or blocked browser storage leaves chat usable', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadHistory(broken), { activeId: null, chats: [] });
  assert.equal(saveHistory(broken, { activeId: 'one', chats: [] }), false);
});

test('evidence excerpt quotes the matching draft note sentence exactly', () => {
  const note = 'Private set intersection compares sets. Differential privacy limits information about individuals in aggregate releases.';
  const excerpt = sourceNoteExcerpt(note, 'How does differential privacy help?');
  assert.equal(excerpt, 'Differential privacy limits information about individuals in aggregate releases.');
  assert.deepEqual(matchingWords('How does differential privacy help?', note), ['differential', 'privacy']);
  assert.equal(sourceNoteExcerpt('The D.C. pilot tested PSI with mock records. It reported caveats.', 'PSI in D.C.?'),
    'The D.C. pilot tested PSI with mock records.');
});
