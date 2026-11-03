// 플러그인이 thinking·effort·캐시 설정을 실제 요청 본문에 넣는지, API 키 없이 확인합니다.
// 로컬 서버가 Anthropic Messages API처럼 SSE를 돌려주고, 받은 요청 본문을 기록합니다.
import { initializeLogger, llm } from '@livekit/agents';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VoiceAnthropicLLM } from './anthropic.ts';

initializeLogger({ pretty: false, level: 'error' });

function sse(events: object[]): string {
  return events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
}

// Haiku 5.5가 생각 모드일 때처럼 생각 블록 뒤에 답을 보냅니다.
const RESPONSE = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-haiku-5-5',
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '네, 좋아요.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]);

let server: Server;
let baseURL: string;
let lastBody: Record<string, unknown>;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(RESPONSE);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  lastBody = {};
});

function chatCtx() {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: '당신은 상담사입니다.' });
  ctx.addMessage({ role: 'assistant', content: '안녕하세요.' });
  ctx.addMessage({ role: 'user', content: '네' });
  return ctx;
}

describe('VoiceAnthropicLLM', () => {
  it('생각 모드 off + effort low + 캐시를 요청에 넣고 temperature는 보내지 않는다', async () => {
    const model = new VoiceAnthropicLLM({
      model: 'claude-haiku-5-5',
      apiKey: 'test',
      baseURL,
      effort: 'low',
      thinking: 'off',
    });
    const res = await model.chat({ chatCtx: chatCtx() }).collect();

    expect(lastBody.model).toBe('claude-haiku-5-5');
    expect(lastBody.thinking).toEqual({ type: 'disabled' });
    expect(lastBody.output_config).toEqual({ effort: 'low' });
    expect(lastBody.cache_control).toEqual({ type: 'ephemeral' });
    expect(lastBody).not.toHaveProperty('temperature');
    expect(res.text).toBe('네, 좋아요.');
  });

  it('adaptive면 생각 블록이 와도 답 텍스트만 내보낸다', async () => {
    const model = new VoiceAnthropicLLM({
      model: 'claude-haiku-5-5',
      apiKey: 'test',
      baseURL,
      effort: 'medium',
      thinking: 'adaptive',
    });
    const res = await model.chat({ chatCtx: chatCtx() }).collect();

    expect(lastBody.thinking).toEqual({ type: 'adaptive' });
    expect(lastBody.output_config).toEqual({ effort: 'medium' });
    expect(res.text).toBe('네, 좋아요.');
  });

  it('대화가 assistant로 끝나도 prefill이 되지 않게 user 턴으로 끝난다', async () => {
    const model = new VoiceAnthropicLLM({
      model: 'claude-haiku-5-5',
      apiKey: 'test',
      baseURL,
      effort: 'low',
      thinking: 'off',
    });
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'system', content: '당신은 상담사입니다.' });
    ctx.addMessage({ role: 'assistant', content: '안녕하세요.' });
    await model.chat({ chatCtx: ctx }).collect();

    const messages = lastBody.messages as { role: string }[];
    expect(messages.at(-1)?.role).toBe('user');
  });
});
