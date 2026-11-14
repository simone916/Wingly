import { getSetting } from '../db.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';

export const PROVIDERS = ['anthropic', 'openai', 'ollama', 'openai-compatible'];

/** Settings saved in the UI win; environment variables are the fallback. */
export function getAIConfig() {
  const saved = getSetting('ai');
  if (saved?.provider) return saved;
  const env = process.env;
  if (env.WINGLY_AI_PROVIDER) {
    return {
      provider: env.WINGLY_AI_PROVIDER,
      apiKey: env.WINGLY_AI_API_KEY || '',
      model: env.WINGLY_AI_MODEL || '',
      baseUrl: env.WINGLY_AI_BASE_URL || '',
    };
  }
  if (env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, model: '', baseUrl: '' };
  return null;
}

export function publicAIConfig() {
  const c = getAIConfig();
  if (!c) return { configured: false };
  return {
    configured: true,
    provider: c.provider,
    model: c.model || (c.provider === 'anthropic' ? anthropic.DEFAULT_MODEL : ''),
    baseUrl: c.baseUrl || '',
    hasKey: !!c.apiKey, // the key itself never leaves the server
  };
}

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw new Error('The AI returned something that was not valid JSON.');
}

/** Ask the configured model for a JSON object matching `schema`. */
export async function completeJSON(request, cfg = getAIConfig()) {
  if (!cfg) throw Object.assign(new Error('No AI provider is configured. Add one in Settings.'), { status: 400 });
  if (!PROVIDERS.includes(cfg.provider)) throw new Error(`Unknown AI provider: ${cfg.provider}`);
  const impl = cfg.provider === 'anthropic' ? anthropic : openai;
  if (cfg.provider === 'anthropic' && !cfg.apiKey) throw new Error('Add an Anthropic API key in Settings.');
  return extractJSON(await impl.complete(cfg, request));
}
