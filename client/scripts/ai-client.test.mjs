import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { AiClient } from '../src/services/ai-client.js';

async function gateway(t, reply) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: body ? JSON.parse(body) : null });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }));
    } else reply(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { requests, config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'deepseek-v4-pro' } };
}

test('connection probe detects the same upstream EOF as summary generation', async (t) => {
  const { config } = await gateway(t, response => {
    response.writeHead(502, { 'X-Request-Id': 'eof-test-request' });
    response.end(JSON.stringify({ error: { message: 'unexpected EOF' } }));
  });
  const client = new AiClient();
  await assert.rejects(client.createMinutes('会议正文。', config, '', ''), /unexpected EOF/);
  await assert.rejects(client.probe(config), error => {
    assert.match(error.message, /unexpected EOF/);
    assert.match(error.message, /HTTP 502/);
    assert.match(error.message, /eof-test-request/);
    return true;
  });
});

test('successful probe actually calls the configured model', async (t) => {
  const { config, requests } = await gateway(t, response => {
    response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  assert.equal((await new AiClient().probe(config)).ok, true);
  const chat = requests.find(request => request.path === '/v1/chat/completions');
  assert.ok(chat, 'The probe must exercise generation, not only the model list');
  assert.equal(chat.body.model, config.model);
});

test('an empty model response cannot pass connectivity testing', async (t) => {
  const { config } = await gateway(t, response => {
    response.end(JSON.stringify({ choices: [] }));
  });
  await assert.rejects(new AiClient().probe(config), /未返回有效文本/);
});

test('truncated successful JSON keeps the HTTP status and request ID', async (t) => {
  const { config } = await gateway(t, response => {
    response.setHeader('X-Request-Id', 'truncated-test-request');
    response.end('{"choices":[');
  });
  await assert.rejects(new AiClient().createMinutes('会议正文。', config, '', ''), error => {
    assert.match(error.message, /模型响应读取失败/);
    assert.match(error.message, /HTTP 200/);
    assert.match(error.message, /truncated-test-request/);
    return true;
  });
});
