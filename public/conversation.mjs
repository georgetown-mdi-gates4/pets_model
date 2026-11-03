export function conversationalReply(text) {
  const message = text.trim().toLowerCase().replace(/[!?.]+$/g, '').trim();
  if (/^(?:what(?:'s| is) your name|who are you|tell me about yourself)$/.test(message)) {
    return 'I’m PETs Model. Tell me about the privacy challenge you’re working on.';
  }
  if (/^(?:what can you do|how can you help|what do you do)$/.test(message)) {
    return 'I can help you work through a data privacy use case and explore suitable PETs. What are you trying to do with the data?';
  }
  if (/^(hi|hello|hey|hi there|hello there|hey there|good morning|good afternoon|good evening)$/.test(message)) {
    return 'Hi! Tell me what you’re working on or ask me about a privacy-enhancing technology.';
  }
  if (/^(thanks|thank you|thank you so much|thx)$/.test(message)) {
    return 'You’re welcome. What else would you like to explore?';
  }
  return null;
}

/** Ask for the case facts that determine a PET choice before retrieving studies. */
export function openingUseCaseQuestion(text, profile = {}, context = []) {
  const message = String(text || '');
  const factualQuestion = /^\s*(?:what is|what are|explain|define|how does|how do|tell me about|compare)\b/i.test(message);
  if (factualQuestion || conversationalReply(message)) return null;
  const caseCue = /\b(?:i|we|my|our|us|i'm|i’d|i'd|we're|we’d|we'd)\b/i.test(message)
    && /\b(?:data|records?|information|dataset|student|school|agency|department|project|use\s*case)\b/i.test(message)
    && /\b(?:shar\w*|send|transfer|provide|link\w*|match\w*|analy[sz]\w*|publish\w*|releas\w*|protect\w*|secur\w*|recommend\w*|help|use)\b/i.test(message);
  const continuing = Object.keys(profile).length > 0 && context.some(turn => turn?.role === 'assistant' && /\?/.test(turn.text || ''));
  if (!caseCue && !continuing) return null;
  if (!profile.goal) return 'What are you trying to do with the data after sharing it—for example, link records, run an analysis, or publish a result?';
  if (!profile.sensitivity) return 'What kind of data is involved? Please describe the categories, not individual records or identifiers.';
  if (!profile.holders) return 'How many organizations hold the data, and who would receive the result?';
  if (profile.goal === 'link' && !profile.match) return 'Do you need exact matches, or must the linkage handle misspellings and missing values?';
  if (['link', 'statistics', 'access'].includes(profile.goal) && !profile.output) return 'What should the recipient receive: individual records, aggregate results, or something else?';
  if (['link', 'access', 'train'].includes(profile.goal) && !profile.rawMove) return 'Can the raw data move to a controlled shared environment, or must it stay with each holder?';
  return null;
}
