// Minimal stdio MCP server: newline-delimited JSON-RPC.
// Exists to prove the real spawn → initialize → tools/list → tools/call path.
let buffer = '';
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

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'echo-proof', version: '1.0.0' },
    }});
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      {
        name: 'echo.shout',
        description: 'Uppercases the given text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'whoami',
        description: 'Reports whether MOZI credentials leaked into this process',
        inputSchema: { type: 'object', properties: {} },
      },
    ]}});
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'echo.shout') {
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: String(args?.text ?? '').toUpperCase() }],
      }});
      return;
    }
    if (name === 'whoami') {
      const leaked = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOZI_MASTER_KEY', 'JWT_SECRET']
        .filter((key) => process.env[key] !== undefined);
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify({
          leaked_vars: leaked,
          declared_var: process.env.PROOF_DECLARED ?? null,
          env_count: Object.keys(process.env).length,
        })}],
      }});
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool ${name}` } });
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
}
