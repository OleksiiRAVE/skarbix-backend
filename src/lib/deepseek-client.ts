import { env } from '../config/env.js';

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export async function createDeepSeekCompletion(messages: DeepSeekMessage[]) {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('DeepSeek is not configured');
  }

  const response = await fetch(`${env.DEEPSEEK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = await response.json() as DeepSeekResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek returned an empty response');
  }

  return content;
}
