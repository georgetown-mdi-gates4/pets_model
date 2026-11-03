export function conversationalReply(text) {
  const message = text.trim().toLowerCase().replace(/[!?.]+$/g, '').trim();
  if (/^(hi|hello|hey|hi there|hello there|hey there|good morning|good afternoon|good evening)$/.test(message)) {
    return 'Hi! Tell me what you’re working on or ask me about a privacy-enhancing technology.';
  }
  if (/^(thanks|thank you|thank you so much|thx)$/.test(message)) {
    return 'You’re welcome. What else would you like to explore?';
  }
  return null;
}
