import { tokens } from './retrieval.mjs';

const COMMON = new Set(['about', 'after', 'before', 'could', 'does', 'have', 'much', 'should', 'their', 'there', 'these', 'this', 'those', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);

export function matchingWords(query, sourceText) {
  const words = [...new Set(String(query || '').toLowerCase().match(/[a-z][a-z-]*/g) || [])];
  const source = String(sourceText || '').toLowerCase();
  return words.filter(word => (word.length >= 4 || ['dp', 'psi', 'mpc', 'pprl'].includes(word)) &&
    !COMMON.has(word) && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(source)).slice(0, 5);
}

export function sourceNoteExcerpt(text, query, maxLength = 320) {
  const note = String(text || '').trim();
  if (!note) return '';
  const sentences = note.split(/(?<=[a-z0-9]{2}[.!?])\s+(?=[A-Z])/i).map(value => value.trim()).filter(Boolean);
  const words = [...new Set(tokens(query))];
  const best = sentences.reduce((current, sentence) => {
    const sentenceTerms = new Set(tokens(sentence));
    const score = words.filter(word => sentenceTerms.has(word)).length;
    return score > current.score ? { sentence, score } : current;
  }, { sentence: sentences[0], score: -1 }).sentence;
  if (best.length <= maxLength) return best;
  const cut = best.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return `${cut || best.slice(0, maxLength)}…`;
}
