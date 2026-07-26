// Stdio MCP server that completes the handshake, answers `tools/list` once,
// fails `tools/call`, and then goes silent forever.
//
// Exists to drive the case @ai-sdk/mcp cannot recover from on its own: its
// request layer has no timeout and no abort listener, so a request that is
// accepted and never answered hangs the caller until the process dies.
let buffer = '';
let listCount = 0;

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle({ id, method }) {
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'hang-proof', version: '1.0.0' },
    }});
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    listCount += 1;
    // The first list is answered so the tool gets exposed. Every later list —
    // i.e. the liveness probe after a failed call — is swallowed.
    if (listCount > 1) return;
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'stall',
      description: 'Fails, then the server stops answering',
      inputSchema: { type: 'object', properties: {} },
    }]}});
    return;
  }
  if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'deliberate failure' } });
    return;
  }
  // Everything else is swallowed on purpose.
}
