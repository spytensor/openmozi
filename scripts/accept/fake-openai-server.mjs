/**
 * Deterministic OpenAI-compatible chat/completions server for acceptance tests.
 *
 * This is NOT a mock of MOZI logic — it only stands in for the LLM transport so
 * the REAL runtime (brain-engine tool loop, artifact pipeline, WS broadcast)
 * executes real work deterministically. Per the project philosophy the model is
 * a swappable scheduler; here we script its tokens so tests are reproducible.
 *
 * Wire it up by pointing an openai-compat provider's base URL at this server,
 * e.g. DEEPSEEK_BASE_URL=http://127.0.0.1:<port> and brain_provider=deepseek.
 *
 * Behaviour is chosen per-request by inspecting the conversation + a mode:
 *   - mode "text": always answer with plain text.
 *   - mode "writefile:<path>": first turn calls write_file(path, content);
 *       after the tool result, answers with text.
 *   - mode "two_artifacts": first turn calls create_artifact twice with the
 *       SAME title; after tool results, answers with text.
 *   - mode "slow_text": answer with text, but delay so the turn stays in-flight
 *       long enough for a concurrent message to race it.
 */
import { createServer } from 'node:http';

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1700000000,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
function hasToolResult(messages) {
  return Array.isArray(messages) && messages.some((m) => m && m.role === 'tool');
}

async function streamText(res, text, { delayMs = 0 } = {}) {
  sse(res, chunk({ role: 'assistant', content: '' }));
  const parts = text.match(/.{1,12}/g) ?? [text];
  for (const p of parts) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    sse(res, chunk({ content: p }));
  }
  sse(res, chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

async function streamToolCalls(res, calls, { pieceDelayMs = 8 } = {}) {
  // Announce all calls with ids/names, then stream their arguments in pieces.
  sse(res, chunk({
    role: 'assistant', content: null,
    tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } })),
  }));
  for (let i = 0; i < calls.length; i++) {
    const argStr = JSON.stringify(calls[i].args);
    const pieces = argStr.match(/.{1,16}/g) ?? [argStr];
    for (const piece of pieces) {
      await new Promise((r) => setTimeout(r, pieceDelayMs));
      sse(res, chunk({ tool_calls: [{ index: i, function: { arguments: piece } }] }));
    }
  }
  sse(res, chunk({}, 'tool_calls'));
  res.write('data: [DONE]\n\n');
  res.end();
}

export function startFakeOpenAI({ mode = 'text', host = '127.0.0.1' } = {}) {
  const capturedRequests = [];
  const server = createServer((req, res) => {
    if (!req.url || !/chat\/completions/.test(req.url)) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const messages = payload.messages ?? [];
      capturedRequests.push({ raw: body, messages });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const done = hasToolResult(messages);
      try {
        if (mode.startsWith('writefile:')) {
          const path = mode.slice('writefile:'.length);
          if (done) return void streamText(res, `Wrote ${path}.`);
          return void streamToolCalls(res, [
            { id: 'call_wf', name: 'write_file', args: { path, content: `# scripted content for ${path}\nhello\n` } },
          ]);
        }
        if (mode.startsWith('writefile_slow:')) {
          const path = mode.slice('writefile_slow:'.length);
          if (done) return void streamText(res, `Wrote ${path}.`);
          // Large content so the tool-arg stream stays in-flight long enough to
          // click stop while the live artifact is open.
          const big = '<div>line</div>\n'.repeat(400);
          return void streamToolCalls(res, [
            { id: 'call_wf', name: 'write_file', args: { path, content: big } },
          ], { pieceDelayMs: 12 });
        }
        if (mode === 'artifact_sentinel') {
          // Turn 1 only: create an artifact whose body carries a unique sentinel.
          // Any later turn (>=2 user messages) answers plain text, so the ONLY
          // way the sentinel can appear in a later request is via replayed
          // history — exactly what the token-bloat fix must summarize away.
          const userCount = messages.filter((m) => m && m.role === 'user').length;
          if (done || userCount >= 2) return void streamText(res, 'Acknowledged.');
          const sentinel = 'ARTIFACT_BODY_SENTINEL_9f3xQ';
          const big = `<html><body>${sentinel} ` + '<p>content</p>'.repeat(300) + '</body></html>';
          return void streamToolCalls(res, [
            { id: 'call_art', name: 'create_artifact', args: { title: 'Report', content_type: 'html', code: big } },
          ]);
        }
        if (mode === 'two_artifacts') {
          if (done) return void streamText(res, 'Created two artifacts.');
          return void streamToolCalls(res, [
            { id: 'call_a1', name: 'create_artifact', args: { title: 'Report', content_type: 'html', code: '<h1>One</h1>' } },
            { id: 'call_a2', name: 'create_artifact', args: { title: 'Report', content_type: 'html', code: '<h1>Two</h1>' } },
          ]);
        }
        if (mode === 'slow_text') {
          return void streamText(res, 'This is a slow scripted answer that streams over time.', { delayMs: 120 });
        }
        // default: text
        return void streamText(res, 'Hello from the scripted model.');
      } catch (err) {
        try { res.end(); } catch {}
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const port = server.address().port;
      resolve({
        server, port, baseUrl: `http://${host}:${port}`,
        getRequests: () => capturedRequests.slice(),
        clearRequests: () => { capturedRequests.length = 0; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
