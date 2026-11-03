import { FIELDS, assessCase, cleanProfile, inferProfile, nextQuestion, profileLabel } from './engine.mjs';
import { createIndex, retrieve, evidenceFor } from './retrieval.mjs';
import { conversationalReply } from './conversation.mjs';

const $ = selector => document.querySelector(selector);
const el = (tag, className = '', text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const state = {
  index: createIndex([]), profile: {}, evidence: [], transcript: [],
  mode: 'learn', sourceStatus: 'loading', lastTopicQuery: '', pendingQuestion: null,
  busy: false, turn: 0, controller: null, apiUnavailable: false, aiNoticeShown: false
};
const messages = $('#messages');
const mascot = $('#mascot');
let mascotTimer;
let mascotReplyTimer;

function setMascot(action, duration = 0) {
  clearTimeout(mascotTimer);
  clearTimeout(mascotReplyTimer);
  mascot.dataset.action = action;
  if (duration) mascotTimer = setTimeout(() => { mascot.dataset.action = 'idle'; }, duration);
}

function reactToAnswer(action) {
  clearTimeout(mascotTimer);
  clearTimeout(mascotReplyTimer);
  mascotReplyTimer = setTimeout(() => setMascot(action, action === 'jumping' ? 1450 : 1200), 240);
}

function safeLink(url, label, className = '') {
  const link = el('a', className, label);
  if (/^https:\/\//.test(url || '')) {
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return link;
}

function collapseEarlierRecommendations() {
  messages.querySelectorAll('.answer.is-recommendation:not(.is-collapsed)').forEach(answer => {
    const details = el('details', 'prior-answer');
    const content = el('div', 'prior-answer-content');
    content.append(...answer.childNodes);
    details.append(el('summary', '', 'Earlier recommendation'), content);
    answer.replaceChildren(details);
    answer.classList.add('is-collapsed');
  });
}

function addMessage(kind, content) {
  messages.querySelectorAll('.choice:not([disabled]), .case-field select:not([disabled])')
    .forEach(control => { control.disabled = true; });
  if (kind === 'assistant') collapseEarlierRecommendations();
  const row = el('div', `message-row ${kind}`);
  const avatar = el('div', 'avatar', kind === 'assistant' ? '✳' : 'You');
  avatar.setAttribute('aria-hidden', 'true');
  const bubble = el('div', 'bubble');
  if (typeof content === 'string') bubble.textContent = content;
  else bubble.append(content);
  row.append(avatar, bubble);
  messages.append(row);
  document.body.classList.add('has-messages');
  if (kind === 'user') setMascot('waiting');
  else if (bubble.querySelector('.answer-warning')) reactToAnswer('review');
  else if (bubble.querySelector('.pet-step')) reactToAnswer('jumping');
  else reactToAnswer('waving');
  state.transcript.push({
    role: kind,
    text: (bubble.innerText || bubble.textContent || '').trim(),
    sources: kind === 'assistant' ? state.evidence.map(hit => ({ title: hit.document.title, url: hit.document.url })) : []
  });
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateControls() {
  const disabled = state.sourceStatus !== 'ready' || state.busy;
  $('#prompt').disabled = disabled;
  $('#composer button[type="submit"]').disabled = disabled;
  $('#export').disabled = disabled;
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = disabled; });
}

function setSourceStatus(status) {
  state.sourceStatus = status;
  updateControls();
}

function sourceDetails(hits, extra) {
  const details = el('details', 'answer-details');
  details.append(el('summary', '', extra ? 'Why and sources' : 'Sources'));
  const content = el('div', 'answer-detail-content');
  content.append(el('p', 'review-note', 'Draft summaries. Check the original sources.'));
  if (extra) content.append(extra);
  const unique = hits.filter((hit, i) => hits.findIndex(x => x.document.url === hit.document.url) === i);
  if (unique.length) {
    const list = el('ul', 'source-links');
    unique.slice(0, 5).forEach(({ document: doc }) => {
      const item = el('li');
      item.append(safeLink(doc.url, `${doc.title} ↗`, 'citation'));
      list.append(item);
    });
    content.append(list);
  } else content.append(el('p', '', 'No close public source matched this question.'));
  details.append(content);
  return details;
}

function checkedModelAnswer(payload) {
  if (payload?.status !== 'ok' || !Array.isArray(payload.segments) || !Array.isArray(payload.sources)
    || !payload.segments.length || payload.segments.length > 8) return null;
  const publicDocs = new Map(state.index.docs.map(doc => [doc.id, doc]));
  const supplied = new Map();
  for (const source of payload.sources) {
    const doc = publicDocs.get(source?.id);
    if (!doc || source.url !== doc.url || supplied.has(doc.id)) return null;
    supplied.set(doc.id, doc);
  }
  const segments = [];
  const cited = new Map();
  for (const segment of payload.segments) {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text || text.length > 2200 || !Array.isArray(segment.source_ids) || !segment.source_ids.length) return null;
    const docs = [];
    for (const id of segment.source_ids) {
      const doc = supplied.get(id);
      if (!doc) return null;
      if (!docs.some(entry => entry.id === id)) docs.push(doc);
      cited.set(id, doc);
    }
    segments.push({ text, docs });
  }
  return { segments, hits: [...cited.values()].map(document => ({ document, score: 1 })) };
}

function citedParagraphs(model) {
  const content = el('div', 'model-explanation');
  model.segments.forEach(segment => {
    const paragraph = el('p', 'source-answer', `${segment.text} `);
    segment.docs.forEach((doc, i) => {
      if (i) paragraph.append(document.createTextNode(' '));
      paragraph.append(safeLink(doc.url, segment.docs.length === 1 ? 'Source ↗' : `${i + 1} ↗`, 'inline-citation'));
    });
    content.append(paragraph);
  });
  return content;
}

function modelMessage(model, title = '') {
  state.evidence = model.hits;
  state.pendingQuestion = null;
  const answer = el('div', 'answer');
  if (title) answer.append(el('h2', 'answer-title', title));
  answer.append(citedParagraphs(model), sourceDetails(model.hits));
  return answer;
}

async function requestModel(intent, query) {
  if (state.apiUnavailable) return { unavailable: true };
  const controller = new AbortController();
  state.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  const context = state.transcript.slice(0, -1).slice(-4).map(entry => ({
    role: entry.role, text: entry.text.slice(0, 500)
  }));
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: query, intent, profile: cleanProfile(state.profile), context }),
      cache: 'no-store',
      signal: controller.signal
    });
    if (response.status === 404 || response.status === 405) state.apiUnavailable = true;
    if (!response.ok) return { unavailable: true };
    const payload = await response.json();
    if (payload?.status === 'review') return { review: true };
    if (payload?.status === 'unavailable') return { unavailable: true };
    if (payload?.status === 'insufficient') return null;
    return checkedModelAnswer(payload) || { unavailable: true };
  } catch {
    return { unavailable: true };
  } finally {
    clearTimeout(timeout);
    if (state.controller === controller) state.controller = null;
  }
}

function localAnswer(answer, unavailable = false) {
  if (unavailable && !state.aiNoticeShown && answer instanceof HTMLElement) {
    answer.append(el('p', 'ai-note', 'AI is unavailable. Showing public sources.'));
    state.aiNoticeShown = true;
  }
  return answer;
}

function pendingMessage() {
  const row = el('div', 'message-row assistant pending');
  row.append(el('div', 'bubble pending-bubble', 'Looking through public sources…'));
  messages.append(row);
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return row;
}

async function modelTurn(intent, query, fallback, title = '') {
  if (state.apiUnavailable) {
    addMessage('assistant', localAnswer(fallback(), true));
    return;
  }
  const turn = ++state.turn;
  state.busy = true;
  updateControls();
  setMascot('waiting');
  const pending = pendingMessage();
  const model = await requestModel(intent, query);
  if (turn !== state.turn) return;
  pending.remove();
  state.busy = false;
  updateControls();
  if (model?.review) addMessage('assistant', legalMessage(query));
  else if (model && !model.unavailable) addMessage('assistant', intent === 'choose' ? fallback(model) : modelMessage(model, title));
  else addMessage('assistant', localAnswer(fallback(), Boolean(model?.unavailable)));
  $('#prompt').focus();
}

function caseDetails() {
  const details = el('details', 'answer-details case-details');
  details.append(el('summary', '', 'Case details'));
  const editor = el('div', 'case-editor');
  for (const [key, field] of Object.entries(FIELDS)) {
    const label = el('label', 'case-field');
    label.append(el('span', 'field-label', field.label));
    const select = el('select');
    select.name = key;
    const placeholder = el('option', '', 'Not answered');
    placeholder.value = '';
    select.append(placeholder);
    field.options.forEach(([value, name]) => {
      const option = el('option', '', name);
      option.value = value;
      select.append(option);
    });
    select.value = state.profile[key] || '';
    select.addEventListener('change', () => {
      if (select.value) state.profile[key] = select.value;
      else delete state.profile[key];
      state.pendingQuestion = null;
      const answer = select.value ? profileLabel(key, select.value) : 'Not answered';
      addMessage('user', `${field.label} ${answer}`);
      showRecommendation(`Case detail: ${field.label} ${answer}`);
    });
    label.append(select);
    editor.append(label);
  }
  details.append(editor);
  return details;
}

function reasons(result) {
  const content = el('div', 'answer-reasons');
  const choices = [...result.primary, ...result.complementary, ...result.alternatives];
  if (choices.length) {
    const list = el('ul');
    choices.forEach(entry => {
      const item = el('li');
      item.append(el('strong', '', entry.name), document.createTextNode(` — ${entry.reason} Check: ${entry.caveat}`));
      list.append(item);
    });
    content.append(list);
  }
  if (result.avoid.length) {
    const list = el('ul');
    result.avoid.forEach(item => list.append(el('li', '', item.reason)));
    content.append(el('strong', '', 'Watch for'), list);
  }
  content.append(el('p', 'review-note', 'Review the design with privacy and PET specialists before use.'));
  return content;
}

function followupQuestion(question) {
  const follow = el('div', 'followup');
  follow.append(el('p', 'followup-question', question.text));
  const choices = el('div', 'choice-list');
  FIELDS[question.field].options.forEach(([value, label]) => {
    const button = el('button', 'choice', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      state.profile[question.field] = value;
      state.pendingQuestion = null;
      addMessage('user', label);
      showRecommendation(`Case detail: ${question.text} ${label}`);
    });
    choices.append(button);
  });
  follow.append(choices);
  return follow;
}

function recommendationMessage(result, query, model = null) {
  const answer = el('div', 'answer is-recommendation');
  const question = nextQuestion(result);
  if (result.status === 'escalate') {
    answer.append(el('h2', 'answer-title', 'Check permissions first'));
    answer.append(el('p', 'answer-lead answer-warning', result.summary));
  } else if (result.primary.length) {
    answer.append(el('h2', 'answer-title', 'A possible approach'));
    const steps = el('div', 'pet-steps');
    result.primary.forEach(entry => {
      const step = el('div', 'pet-step');
      step.append(el('strong', '', entry.name), el('p', '', entry.reason));
      steps.append(step);
    });
    answer.append(steps);
    const layers = result.complementary.filter(entry => entry.code !== 'governance');
    if (layers.length) answer.append(el('p', 'also-consider', `Also consider: ${layers.map(entry => entry.name).join(' · ')}`));
  }

  if (model) answer.append(citedParagraphs(model));

  state.pendingQuestion = question;
  if (question) answer.append(followupQuestion(question));

  const codes = [...result.primary, ...result.complementary, ...result.alternatives].map(entry => entry.code);
  const ruleHits = codes.length ? evidenceFor(state.index, query, codes, 5) : [];
  const hits = [...ruleHits, ...(model?.hits || [])]
    .filter((hit, i, all) => all.findIndex(entry => entry.document.id === hit.document.id) === i);
  state.evidence = hits;
  if (codes.length || result.avoid.length) answer.append(sourceDetails(hits, reasons(result)));
  if (Object.keys(state.profile).length) answer.append(caseDetails());
  return answer;
}

function showRecommendation(query) {
  if (state.sourceStatus !== 'ready') return;
  state.mode = 'choose';
  const assessment = assessCase(state.profile);
  if (assessment.status === 'escalate' || !assessment.primary.length) {
    addMessage('assistant', recommendationMessage(assessment, query));
    return;
  }
  void modelTurn('choose', query, model => recommendationMessage(assessment, query, model));
}

function learningMessage(query, retrievalQuery = query) {
  let hits = retrieve(state.index, retrievalQuery, { limit: 12 });
  if (/^\s*(what is|what are|define|explain)\b/i.test(query)) {
    hits = hits.slice().sort((a, b) => {
      const definition = hit => hit.document.id.endsWith('definition') || hit.document.tags.includes('definition') ? 1 : 0;
      const offTopic = hit => /differential privacy|\bdp\b/i.test(query) && !/synthetic|fake/i.test(query) && hit.document.tags.includes('synthetic_data') ? 1 : 0;
      return definition(b) - definition(a) || offTopic(a) - offTopic(b) || b.score - a.score;
    });
  }
  hits = hits.slice(0, 4);
  state.evidence = hits;
  state.pendingQuestion = null;
  const answer = el('div', 'answer');
  if (!hits.length) {
    answer.append(el('p', 'answer-lead', 'I could not find a close match. Try naming a PET or describing what you need to do.'));
    return answer;
  }
  const count = /\b(compare|difference|versus|vs\.?|between)\b/i.test(query) ? 2 : 1;
  const seen = new Set();
  hits.slice(0, count).forEach(hit => {
    if (seen.has(hit.document.text)) return;
    seen.add(hit.document.text);
    const paragraph = el('p', 'source-answer', `${hit.document.text} `);
    paragraph.append(safeLink(hit.document.url, 'Source ↗', 'inline-citation'));
    answer.append(paragraph);
  });
  answer.append(sourceDetails(hits));
  return answer;
}

function planningMessage(query) {
  const assessment = assessCase(state.profile);
  if (assessment.profile.goal && assessment.status === 'escalate') return recommendationMessage(assessment, query);
  const codes = [...assessment.primary, ...assessment.complementary].map(entry => entry.code);
  const hits = codes.length
    ? evidenceFor(state.index, query, codes, 5)
    : retrieve(state.index, `${query} pilot evaluation governance`, { limit: 5 });
  state.evidence = hits;
  state.pendingQuestion = null;
  const answer = el('div', 'answer');
  answer.append(el('h2', 'answer-title', 'Plan a small pilot'));
  const steps = [
    ['Define the use', 'Record the purpose, data holders, permitted data flows, and needed output.'],
    ['Compare options', assessment.primary.length
      ? `Test ${assessment.primary.map(entry => entry.name).join(' and ')} against a simpler baseline.`
      : 'Compare a PET approach with a simpler baseline.'],
    ['Test', 'Use mock or approved data to measure privacy risk, usefulness, and effort.'],
    ['Review', 'Have privacy, legal, domain, and technical owners review before live use or release.']
  ];
  const list = el('ol', 'plan-steps');
  steps.forEach(([title, detail]) => {
    const item = el('li');
    item.append(el('strong', '', title), document.createTextNode(` — ${detail}`));
    list.append(item);
  });
  answer.append(list, sourceDetails(hits));
  return answer;
}

function isLegalQuestion(text) {
  const clause = text.trim().split(/[.!?]/).map(x => x.trim()).filter(Boolean).at(-1) || text;
  const terms = /\b(ferpa|gdpr|compliance|compliant|legal|legally|law|lawful|regulation|regulatory|permitted|allowed|consent|authorization|authority|data.sharing agreement)\b/i;
  return terms.test(clause) && (/\b(under|according to)\b/i.test(clause) || /^\s*(can|may|must|should|do|does|is|are|what|how|which|whether|ferpa|gdpr|legal|compliance)\b/i.test(clause));
}

function legalMessage(query) {
  const ferpa = /\bferpa\b/i.test(query);
  const uk = /\b(uk|united kingdom|britain|ico)\b/i.test(query);
  const hits = (ferpa || uk ? retrieve(state.index, query, { limit: 20 }) : [])
    .filter(hit => {
      const host = new URL(hit.document.url).hostname;
      return ferpa ? host === 'studentprivacy.ed.gov' : host === 'ico.org.uk' || host === 'www.gov.uk';
    }).slice(0, 4);
  state.evidence = hits;
  state.pendingQuestion = null;
  const answer = el('div', 'answer');
  answer.append(el('h2', 'answer-title', 'Ask a privacy or legal reviewer'));
  answer.append(el('p', 'answer-lead answer-warning', 'A chat cannot confirm whether this use or disclosure is allowed. A reviewer needs the purpose, data, agreements, and people receiving the result.'));
  answer.append(sourceDetails(hits));
  return answer;
}

function startsNewCase(text) {
  return /\b(?:new|another|different|separate|next|second)\s+(?:use\s*case|case|scenario|project)\b/i.test(text);
}

function isCaseContinuation(text) {
  return /^\s*(also|and|what if|in this case|for this case|in the same case|for the same project|we also|same case|actually|correction|instead)\b/i.test(text);
}

function isTopicFollowup(text) {
  return text.length <= 100 && (/\b(it|its|they|them|their|that|this|those)\b/i.test(text) || /^\s*(tell me more|and how|and why)\b/i.test(text));
}

function classify(text, inferred) {
  if (/\b(plan|pilot|implement|evaluate|roll.?out|deployment|how would we build)\b/i.test(text)) return 'plan';
  if (/^\s*(what is|what are|explain|define|how does|how do|when is|when does|tell me about|compare)\b/i.test(text)
    && !/\b(we need|our (case|data|agency)|which should we|recommend for us)\b/i.test(text)) return 'learn';
  if (Object.keys(inferred).length || /\b(recommend|choose|best|which pet|what should|our case|we need|use case)\b/i.test(text)) return 'choose';
  return 'learn';
}

function answerToPending(text) {
  const field = state.pendingQuestion?.field;
  if (!field) return null;
  const answer = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  const options = FIELDS[field].options;
  const exact = options.find(([value, label]) => answer === value || answer === label.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim());
  if (exact) return exact[0];
  if (/^(yes|no|not sure|unknown)\b/.test(answer)) {
    const value = answer.startsWith('not sure') || answer.startsWith('unknown') ? 'unknown' : answer.startsWith('yes') ? 'yes' : 'no';
    if (options.some(([option]) => option === value)) return value;
  }
  return null;
}

function send(text) {
  const query = text.trim().slice(0, 1200);
  if (!query || state.sourceStatus !== 'ready' || state.busy) return false;
  const inferred = inferProfile(query);
  if (/\b(?:won't|will not|do not|never|no plans? to)\b.{0,35}\b(?:publish|release|share)\b.{0,60}\b(?:names?|identifiers?|pii)\b/i.test(query)) inferred.directRelease = 'no';
  const newCase = startsNewCase(query) || Boolean(inferred.goal && state.profile.goal && inferred.goal !== state.profile.goal && !isCaseContinuation(query));
  if (newCase) reset();
  const pendingAnswer = newCase ? null : answerToPending(query);
  addMessage('user', query);
  const socialReply = conversationalReply(query);
  if (socialReply) {
    state.evidence = [];
    addMessage('assistant', socialReply);
    return true;
  }
  const followup = Boolean(state.mode === 'learn' && state.lastTopicQuery && !inferred.goal && isTopicFollowup(query));
  const intent = pendingAnswer ? 'choose' : isLegalQuestion(query) ? 'legal' : followup ? 'learn' : classify(query, inferred);
  if (intent === 'choose' || intent === 'plan') {
    state.profile = { ...state.profile, ...inferred };
    if (pendingAnswer) state.profile[state.pendingQuestion.field] = pendingAnswer;
  }
  state.mode = intent;
  if (intent === 'legal') addMessage('assistant', legalMessage(query));
  else if (intent === 'plan') {
    const assessment = assessCase(state.profile);
    if (assessment.profile.goal && assessment.status === 'escalate') addMessage('assistant', recommendationMessage(assessment, query));
    else void modelTurn('plan', query, () => planningMessage(query), 'Plan a small pilot');
    state.lastTopicQuery = query;
  }
  else if (intent === 'choose') { showRecommendation(query); state.lastTopicQuery = query; }
  else {
    const retrievalQuery = followup ? `${state.lastTopicQuery} ${query}` : query;
    void modelTurn('learn', retrievalQuery, () => learningMessage(query, retrievalQuery));
    if (!followup) state.lastTopicQuery = query;
  }
  return true;
}

function exportSummary() {
  if (!state.transcript.length) return;
  const assessment = assessCase(state.profile);
  const lines = ['# PETs Model case summary', '', `Exported: ${new Date().toISOString()}`, '', '## Case details'];
  for (const [key, value] of Object.entries(cleanProfile(state.profile))) lines.push(`- ${FIELDS[key].label} ${profileLabel(key, value)}`);
  lines.push('', '## Exploratory architecture', assessment.summary, '', '### Suggested approaches');
  assessment.primary.forEach(entry => lines.push(`- ${entry.name}: ${entry.reason} Check: ${entry.caveat}`));
  assessment.complementary.forEach(entry => lines.push(`- ${entry.name}: ${entry.reason} Check: ${entry.caveat}`));
  lines.push('', '### Questions to resolve');
  assessment.missing.forEach(question => lines.push(`- ${question.text}`));
  lines.push('', '## Conversation', ...state.transcript.flatMap(entry => [
    `### ${entry.role === 'assistant' ? 'Assistant' : 'You'}`,
    entry.text,
    ...(entry.sources.length ? ['', 'Sources:', ...entry.sources.map(source => `- ${source.title} — ${source.url}`)] : []),
    ''
  ]));
  lines.push('Review this local export before sharing. It is not an expert-approved recommendation.');
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pets-model-case-summary.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reset() {
  state.turn += 1;
  state.controller?.abort();
  state.controller = null;
  state.busy = false;
  state.profile = {};
  state.evidence = [];
  state.transcript = [];
  state.lastTopicQuery = '';
  state.pendingQuestion = null;
  state.mode = 'learn';
  state.aiNoticeShown = false;
  messages.replaceChildren();
  document.body.classList.remove('has-messages');
  $('#prompt').value = '';
  updateControls();
  setMascot('waving', 1200);
}

$('#composer').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#prompt');
  if (send(input.value)) input.value = '';
  input.focus();
});
$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => send(button.dataset.prompt)));
$('#export').addEventListener('click', () => { exportSummary(); setMascot('waving', 1200); });
$('#reset').addEventListener('click', reset);

reset();
setSourceStatus('loading');
setMascot('waiting');
fetch('./data/sources.json', { cache: 'no-cache' }).then(response => {
  if (!response.ok) throw new Error(`Sources unavailable (${response.status})`);
  return response.json();
}).then(documents => {
  state.index = createIndex(documents);
  if (!state.index.docs.length) throw new Error('No source passages loaded');
  $('#source-count').textContent = `${state.index.docs.length} source notes`;
  setSourceStatus('ready');
  setMascot('waving', 1200);
}).catch(() => {
  setSourceStatus('failed');
  $('#source-count').textContent = 'Sources unavailable';
  addMessage('assistant', 'The public sources did not load. Refresh the page to try again.');
  setMascot('failed', 1500);
});
