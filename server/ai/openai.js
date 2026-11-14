// OpenAI and anything that speaks its Chat Completions dialect:
// Ollama, LM Studio, llama.cpp, OpenRouter, Groq, Gemini's compatibility endpoint, …

export const PRESET_URLS = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

async function call(cfg, body) {
  const base = (cfg.baseUrl || PRESET_URLS[cfg.provider] || '').replace(/\/+$/, '');
  if (!base) throw new Error('Set a base URL for the AI provider.');
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new Error(`Could not reach ${base}: ${e.cause?.message || e.message}`);
  }
  return res;
}

/** @returns {Promise<string>} raw JSON text */
export async function complete(cfg, { system, messages, schema }) {
  if (!cfg.model) throw new Error('Set a model name for the AI provider.');
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content: `${system}\n\nReply with a single JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`,
      },
      ...messages,
    ],
  };
  let res = await call(cfg, { ...body, response_format: { type: 'json_object' } });
  if (res.status === 400) res = await call(cfg, body); // some servers don't support response_format
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new Error('The AI provider rejected the API key.');
    throw new Error(`AI provider error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('The AI provider returned an empty response.');
  return content;
}
