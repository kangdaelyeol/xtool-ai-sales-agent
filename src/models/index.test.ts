// Bedrock 클라이언트가 남아 있는 Bedrock API 키 대신 IAM 키로 서명하는지, AWS에 보내지 않고 확인합니다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBedrockClient } from './index.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createBedrockClient', () => {
  it('AWS_BEARER_TOKEN_BEDROCK이 있어도 IAM 키로 SigV4 서명한다', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'leftover-api-key');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATESTTESTTESTTEST');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');

    let auth: string | null = null;
    const client = createBedrockClient().withOptions({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        auth = new Request(input, init).headers.get('authorization');
        return new Response('{}', { status: 400 });
      },
    });
    expect(client.apiKey).toBeNull();

    await client.messages
      .create({
        model: 'jp.anthropic.claude-haiku-5-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .catch(() => {});

    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\//);
  });
});
