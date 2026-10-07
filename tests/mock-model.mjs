import { createServer } from 'node:http';

export const modelCatalog = { models: [{
  slug: 'normify-fixture', display_name: 'Normify fixture', description: 'Local deterministic test fixture.',
  default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Fixture only.' }],
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1, upgrade: null,
  base_instructions: 'Run only the isolated hook fixture.', model_messages: null,
  default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null,
  apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
  truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 32768,
  effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'],
  supports_search_tool: false,
  supports_parallel_tool_calls: false,
}] };

// 本地响应夹具；不连接云端或运行模型。
export async function mockModel(edits = 8) {
  let calls = 0;
  const toolResults = [];
  let toolDefinitions;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    toolDefinitions = body.tools?.map(({ type, name, tools }) => ({ type, name,
      tools: tools?.map(({ type, name }) => ({ type, name })) }));
    for (const item of body.input ?? []) {
      if (['custom_tool_call_output', 'function_call_output'].includes(item.type)) toolResults.push(item.output);
    }
    const serial = ++calls;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    const item = serial <= edits ? { type: 'custom_tool_call', id: 'item-' + serial,
      call_id: 'patch-' + serial, name: 'apply_patch',
      input: `*** Begin Patch\n*** Add File: hook-proof-${serial}.txt\n+fixture\n*** End Patch` }
      : { type: 'message', id: 'item-' + serial, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }] };
    const result = { id: 'resp-' + serial, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } };
    emit('response.created', { response: { ...result, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item });
    if (item.type === 'message') emit('response.output_text.delta',
      { item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture complete.' });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: result });
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => calls, toolResults, tools: () => toolDefinitions,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
