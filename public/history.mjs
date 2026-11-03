const KEY = 'pets-model-chat-history-v1';
const MAX_CHATS = 30;
const MAX_MESSAGES = 120;

export function loadHistory(storage) {
  try {
    const data = JSON.parse(storage.getItem(KEY) || 'null');
    if (!data || data.version !== 1 || !Array.isArray(data.chats)) return { activeId: null, chats: [] };
    const chats = data.chats.filter(chat => chat && typeof chat.id === 'string' && Array.isArray(chat.messages))
      .slice(0, MAX_CHATS).map(chat => ({
        id: chat.id.slice(0, 80),
        title: typeof chat.title === 'string' ? chat.title.slice(0, 80) : 'Chat',
        updatedAt: typeof chat.updatedAt === 'string' ? chat.updatedAt : '',
        profile: chat.profile && typeof chat.profile === 'object' && !Array.isArray(chat.profile) ? chat.profile : {},
        mode: ['learn', 'choose', 'plan'].includes(chat.mode) ? chat.mode : 'learn',
        lastTopicQuery: typeof chat.lastTopicQuery === 'string' ? chat.lastTopicQuery.slice(0, 1200) : '',
        pendingField: typeof chat.pendingField === 'string' ? chat.pendingField.slice(0, 32) : '',
        messages: chat.messages.slice(-MAX_MESSAGES).filter(message =>
          message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')
          .map(message => ({
            role: message.role,
            text: message.text.slice(0, 8000),
            sources: Array.isArray(message.sources) ? message.sources.slice(0, 8).filter(source =>
              source && typeof source.id === 'string' && typeof source.url === 'string') : []
          }))
      }));
    return { activeId: typeof data.activeId === 'string' ? data.activeId : null, chats };
  } catch { return { activeId: null, chats: [] }; }
}

export function saveHistory(storage, history) {
  try {
    storage.setItem(KEY, JSON.stringify({
      version: 1,
      activeId: history.activeId,
      chats: history.chats.slice(0, MAX_CHATS)
    }));
    return true;
  } catch { return false; }
}

export function clearHistory(storage) {
  try { storage.removeItem(KEY); } catch { /* Browser storage may be unavailable. */ }
}
