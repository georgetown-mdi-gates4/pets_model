/** Server-only Vertex AI transport. No API key or provider response is sent to the browser. */
export const DEFAULT_MODEL = 'gemini-3.5-flash';

function responseSchema(sourceIds) {
  const grounded = sourceIds.length > 0;
  return {
    type: 'OBJECT',
    description: grounded ? 'A concise PET answer grounded in the supplied public sources.' : 'A concise conversational answer.',
    properties: {
      segments: {
        type: 'ARRAY', minItems: 1, maxItems: 3,
        items: {
          type: 'OBJECT',
          properties: {
            text: { type: 'STRING', description: 'One short, plain-language answer segment.' },
            source_ids: {
              type: 'ARRAY', minItems: grounded ? 1 : 0, maxItems: grounded ? 3 : 0,
              description: 'IDs of the supplied public sources supporting this segment.',
              items: grounded ? { type: 'STRING', format: 'enum', enum: sourceIds } : { type: 'STRING' }
            }
          },
          propertyOrdering: ['text', 'source_ids'],
          required: ['text', 'source_ids']
        }
      }
    },
    required: ['segments']
  };
}

export async function generateGeminiDraft(prompt, sourceIds, {
  apiKey, accessTokenProvider, model = DEFAULT_MODEL, projectId, location = 'global', fetchImpl = fetch, onUsage
} = {}) {
  if (!apiKey && (!accessTokenProvider || !projectId)) throw new Error('Missing model credential');
  if (apiKey && typeof apiKey !== 'string') throw new Error('Invalid model credential');
  if (accessTokenProvider && typeof accessTokenProvider !== 'function') throw new Error('Invalid token provider');
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/i.test(model)) throw new Error('Invalid model name');
  if (projectId && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) throw new Error('Invalid Vertex project ID');
  if (projectId && !/^(?:global|[a-z]+-[a-z]+[0-9])$/.test(location)) throw new Error('Invalid Vertex location');
  if (!Array.isArray(sourceIds)) throw new Error('Invalid source IDs');
  const modelPath = `publishers/google/models/${model}:generateContent`;
  const scope = projectId ? `projects/${projectId}/locations/${location}/` : '';
  const url = `https://aiplatform.googleapis.com/v1/${scope}${modelPath}`;
  const request = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      thinkingConfig: model.startsWith('gemini-2.5-') ? { thinkingBudget: 1024 } : { thinkingLevel: 'LOW' },
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(sourceIds)
    }
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) {
      headers['x-goog-api-key'] = apiKey;
    } else {
      const token = await accessTokenProvider();
      if (typeof token !== 'string' || !token.trim()) throw new Error('Missing model credential');
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Model request failed');
    const result = await response.json();
    if (typeof onUsage === 'function' && result?.usageMetadata) {
      const counts = Object.fromEntries(
        ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
          .filter(key => Number.isSafeInteger(result.usageMetadata[key]) && result.usageMetadata[key] >= 0)
          .map(key => [key, result.usageMetadata[key]])
      );
      try { onUsage({ model, ...counts }); } catch { /* Cost telemetry never changes an answer. */ }
    }
    const candidate = result?.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error('Model response incomplete');
    const text = candidate?.content?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join('');
    if (!text || text.length > 16000) throw new Error('Model response missing or too long');
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}
