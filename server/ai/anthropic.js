import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** @returns {Promise<string>} raw JSON text matching `schema` */
export async function complete(cfg, { system, messages, schema, maxTokens = 16000 }) {
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  let response;
  try {
    response = await client.messages.create({
      model: cfg.model || DEFAULT_MODEL,
      max_tokens: maxTokens,
      // The system prompt carries the (large, stable) library catalog — cache it.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { format: { type: 'json_schema', schema } },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key.');
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic model not found: ${cfg.model || DEFAULT_MODEL}`);
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached — try again shortly.');
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens.');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
