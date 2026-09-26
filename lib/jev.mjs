// Jev (TypeSafe System One) client. Default route: OpenRouter decisions endpoint; JEV_DIRECT=1 uses api.typesafe.ai.
const DEFAULT_BASE = 'https://openrouter.ai/api/alpha/decisions';

export function jevConfig() {
  const direct = process.env.JEV_DIRECT === '1' && process.env.TYPESAFE_API_KEY;
  return direct
    ? { base: 'https://api.typesafe.ai/v1/systemone', key: process.env.TYPESAFE_API_KEY, model: (process.env.JEV_MODEL || 'jev-latest').replace(/^~?typesafe\//, ''), via: 'typesafe' }
    : { base: process.env.JEV_BASE_URL || DEFAULT_BASE, key: process.env.OPENROUTER_API_KEY, model: process.env.JEV_MODEL || '~typesafe/jev-latest', via: 'openrouter' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One decisions call: `state` + `questions` ({id: {type: choice|score|noul, instructions, criteria}}).
// Retries 429/5xx/network with exponential backoff. `attempts` in the result says how many tries it took.
export async function decide({ state, questions, signal, onRetry, timeoutMs = 20000, retries = 6 }) {
  const cfg = jevConfig();
  if (!cfg.key) throw new Error(cfg.via === 'openrouter' ? 'OPENROUTER_API_KEY is not set (export it or put it in .env)' : 'TYPESAFE_API_KEY is not set');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const t0 = Date.now();
    try {
      const res = await fetch(cfg.base, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', 'X-Title': 'LinkedIn ICP Sorter' },
        body: JSON.stringify({ model: cfg.model, state, questions }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status === 529 || res.status >= 500) throw Object.assign(new Error(`Jev ${res.status}: ${json?.error?.message || json?.message || 'retryable'}`), { retryable: true, status: res.status });
      if (!res.ok || json.error) throw Object.assign(new Error(`Jev ${res.status}: ${json?.error?.message || json?.message || JSON.stringify(json).slice(0, 200)}`), { status: res.status });
      return { answers: json.answers || {}, model: json.model, cost: json.usage?.cost ?? 0, tokens: json.usage?.input_tokens ?? 0, ms: Date.now() - t0, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new Error('cancelled');
      const retryable = e.retryable || e.name === 'AbortError' || e.code === 'ECONNRESET' || e.name === 'TypeError';
      if (!retryable || attempt === retries) throw e;
      onRetry?.(e);
      await sleep(Math.min(5000, (e.status === 429 ? 700 : 400) * 1.6 ** attempt) + Math.random() * 400);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}
