const { templates } = require('./aiPromptTemplates');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_FREE_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

const getHeaders = () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.APP_PUBLIC_URL || 'http://localhost:5173',
    'X-Title': 'Edu Flow',
  };
};

const normalizeAiResponse = (data) => {
  const choice = data?.choices?.[0];
  return {
    model: data?.model,
    text: choice?.message?.content || choice?.text || '',
    usage: data?.usage || null,
  };
};

const extractJsonBlock = (text = '') => {
  if (!text) return null;

  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] || text;
  
  // Find the first occurrence of { (object) or [ (array)
  const startBrace = candidate.indexOf('{');
  const startBracket = candidate.indexOf('[');
  
  let startIndex = -1;
  let endChar = '';
  
  if (startBrace !== -1 && (startBracket === -1 || startBrace < startBracket)) {
    startIndex = startBrace;
    endChar = '}';
  } else if (startBracket !== -1) {
    startIndex = startBracket;
    endChar = ']';
  }

  if (startIndex === -1) return null;

  const endIndex = candidate.lastIndexOf(endChar);

  if (endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const jsonStr = candidate.slice(startIndex, endIndex + 1);

  try {
    return JSON.parse(jsonStr);
  } catch {
    try {
      // Lenient parsing: Fix unquoted keys and single quotes often produced by smaller AI models
      const fixedJson = jsonStr
        .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":') // Quote keys
        .replace(/:\s*'([^']*)'/g, ': "$1"') // Fix single quotes
        .replace(/,\s*([}\]])/g, '$1'); // Remove trailing commas
      return JSON.parse(fixedJson);
    } catch (err) {
      console.warn("AI JSON Extraction failed even after lenient cleanup attempt.");
      return null;
    }
  }
};

const complete = async ({ messages, temperature = 0.35, maxTokens = 1400, model = DEFAULT_FREE_MODEL }) => {
  const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenRouter request failed with status ${response.status}`);
  }

  return normalizeAiResponse(data);
};

const stream = async ({ messages, temperature = 0.35, maxTokens = 1400, model = DEFAULT_FREE_MODEL, onToken }) => {
  const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `OpenRouter stream failed with status ${response.status}`);
  }

  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep partial line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.replace(/^data:\s*/, '');
      if (payload === '[DONE]') return { text: fullText, model };

      const data = JSON.parse(payload);
      const token = data?.choices?.[0]?.delta?.content || '';
      if (token) {
        fullText += token;
        onToken(token);
      }
    }
  }

  return { text: fullText, model };
};

const listFreeModels = async () => {
  const response = await fetch(`${OPENROUTER_API_URL}/models`);
  const data = await response.json();
  const models = Array.isArray(data?.data) ? data.data : [];

  return models.filter((model) => {
    const pricing = model.pricing || {};
    return model.id?.endsWith(':free') || pricing.prompt === '0' || pricing.completion === '0';
  });
};

module.exports = {
  DEFAULT_FREE_MODEL,
  complete,
  extractJsonBlock,
  listFreeModels,
  stream,
  templates,
};
