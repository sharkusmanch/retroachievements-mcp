// Live smoke test over stdio: node scripts/smoke.mjs <tool> '<json args>'
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const [tool, args = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: process.env,
    stderr: 'ignore',
  }),
);
if (!tool) {
  const { tools } = await client.listTools();
  const text = JSON.stringify(tools);
  console.log(
    `${tools.length} tools, tools/list = ${text.length} chars (~${Math.round(text.length / 4)} tokens)`,
  );
  for (const t of tools) console.log(`- ${t.name} (${JSON.stringify(t).length} chars)`);
} else {
  const t0 = Date.now();
  const r = await client.callTool({ name: tool, arguments: JSON.parse(args) });
  const text = r.content.map(c => c.text).join('');
  console.log(`[${Date.now() - t0}ms, ${text.length} chars${r.isError ? ', ERROR' : ''}]`);
  console.log(text.length > 3000 ? text.slice(0, 3000) + '…' : text);
}
await client.close();
