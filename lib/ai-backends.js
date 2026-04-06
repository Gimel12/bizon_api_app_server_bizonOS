/**
 * AI Backend Abstraction Layer
 *
 * Supports three backends for the diagnostic chat:
 *   - claude:  Anthropic API (Claude) — tool calling via native API
 *   - vllm:    Local vLLM server (OpenAI-compatible) — tool calling via OpenAI format
 *   - ollama:  Local Ollama server (OpenAI-compatible) — tool calling via OpenAI format
 *
 * All backends expose the same interface so diagnostic.js can swap them transparently.
 */

const Anthropic = require('@anthropic-ai/sdk').default;

// ─── Configuration ─────────────────────────────────────────────────────────

const BACKENDS = {
  claude: {
    name: 'Claude (Anthropic)',
    type: 'anthropic',
    requiresApiKey: true,
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-20250514',
  },
  vllm: {
    name: 'vLLM (Local)',
    type: 'openai',
    baseUrl: process.env.VLLM_BASE_URL || 'http://localhost:8000/v1',
    requiresApiKey: false,
    defaultModel: null, // auto-detected from server
  },
  ollama: {
    name: 'Ollama (Local)',
    type: 'openai',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    requiresApiKey: false,
    defaultModel: null, // auto-detected from server
  },
};

// ─── Health / Discovery ────────────────────────────────────────────────────

/**
 * Check which backends are available right now.
 * Returns { backendId: { available, name, models[], defaultModel } }
 */
async function getAvailableBackends() {
  const results = {};

  // Claude — available if API key is set
  results.claude = {
    name: BACKENDS.claude.name,
    available: !!process.env.ANTHROPIC_API_KEY,
    models: [BACKENDS.claude.defaultModel],
    defaultModel: BACKENDS.claude.defaultModel,
  };

  // vLLM
  try {
    const resp = await fetch(`${BACKENDS.vllm.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      const models = (data.data || []).map(m => m.id);
      results.vllm = {
        name: BACKENDS.vllm.name,
        available: models.length > 0,
        models,
        defaultModel: models[0] || null,
      };
    } else {
      results.vllm = { name: BACKENDS.vllm.name, available: false, models: [], defaultModel: null };
    }
  } catch {
    results.vllm = { name: BACKENDS.vllm.name, available: false, models: [], defaultModel: null };
  }

  // Ollama
  try {
    const resp = await fetch(`${BACKENDS.ollama.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      const models = (data.data || []).map(m => m.id);
      results.ollama = {
        name: BACKENDS.ollama.name,
        available: models.length > 0,
        models,
        defaultModel: models[0] || null,
      };
    } else {
      results.ollama = { name: BACKENDS.ollama.name, available: false, models: [], defaultModel: null };
    }
  } catch {
    results.ollama = { name: BACKENDS.ollama.name, available: false, models: [], defaultModel: null };
  }

  return results;
}

// ─── Claude (Anthropic) Backend ────────────────────────────────────────────

function createClaudeBackend(model) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const modelId = model || BACKENDS.claude.defaultModel;

  const ANTHROPIC_SSH_TOOL = {
    name: 'run_ssh_command',
    description: 'Execute a Linux command on the connected Bizon workstation via SSH. Returns stdout and stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The Linux command to execute (e.g., "nvidia-smi", "free -h", "dmesg | grep error")',
        },
      },
      required: ['command'],
    },
  };

  return {
    name: 'claude',

    async chat(systemPrompt, messages, includeTool) {
      const params = {
        model: modelId,
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      };
      if (includeTool) params.tools = [ANTHROPIC_SSH_TOOL];

      const response = await anthropic.messages.create(params);

      return {
        content: response.content,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
        },
      };
    },

    getToolCalls(content) {
      return content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id,
        name: b.name,
        command: b.input.command,
      }));
    },

    getText(content) {
      return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    },

    buildToolResult(toolCallId, output, isError) {
      return {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: output,
        ...(isError ? { is_error: true } : {}),
      };
    },

    buildAssistantMessage(content) {
      return { role: 'assistant', content };
    },

    buildToolResultsMessage(results) {
      return { role: 'user', content: results };
    },

    buildForceSummaryMessage() {
      return {
        role: 'user',
        content: 'Please summarize your findings based on the commands you have already run. Do not run any more commands.',
      };
    },
  };
}

// ─── OpenAI-Compatible Backend (vLLM / Ollama) ────────────────────────────

const OPENAI_SSH_TOOL = {
  type: 'function',
  function: {
    name: 'run_ssh_command',
    description: 'Execute a Linux command on the connected Bizon workstation via SSH. Returns stdout and stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The Linux command to execute (e.g., "nvidia-smi", "free -h", "dmesg | grep error")',
        },
      },
      required: ['command'],
    },
  },
};

function createOpenAIBackend(backendId, model) {
  const config = BACKENDS[backendId];
  const baseUrl = config.baseUrl;
  const modelId = model || config.defaultModel;

  return {
    name: backendId,

    async chat(systemPrompt, messages, includeTool) {
      // Convert Anthropic-style messages to OpenAI format
      const openaiMessages = [
        { role: 'system', content: systemPrompt },
      ];

      for (const msg of messages) {
        if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            // Convert Anthropic content blocks to OpenAI assistant message
            let text = '';
            const toolCalls = [];
            for (const block of msg.content) {
              if (block.type === 'text') {
                text += block.text;
              } else if (block.type === 'tool_use') {
                toolCalls.push({
                  id: block.id,
                  type: 'function',
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  },
                });
              }
            }
            const assistantMsg = { role: 'assistant', content: text || null };
            if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
            openaiMessages.push(assistantMsg);
          } else {
            openaiMessages.push({ role: 'assistant', content: msg.content });
          }
        } else if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            // Tool results — convert to OpenAI tool role messages
            for (const item of msg.content) {
              if (item.type === 'tool_result') {
                openaiMessages.push({
                  role: 'tool',
                  tool_call_id: item.tool_use_id,
                  content: item.content,
                });
              }
            }
          } else {
            openaiMessages.push({ role: 'user', content: msg.content });
          }
        }
      }

      const body = {
        model: modelId,
        messages: openaiMessages,
        max_tokens: 4096,
        temperature: 0.3,
      };
      if (includeTool) body.tools = [OPENAI_SSH_TOOL];

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer EMPTY' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`${backendId} API error ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const choice = data.choices[0];
      const message = choice.message;

      // Normalize to Anthropic content block format
      const content = [];
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch { args = { command: tc.function.arguments }; }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: args,
          });
        }
      }

      const stopReason = (choice.finish_reason === 'tool_calls' || (message.tool_calls && message.tool_calls.length > 0))
        ? 'tool_use'
        : 'end_turn';

      return {
        content,
        stopReason,
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      };
    },

    getToolCalls(content) {
      return content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id,
        name: b.name,
        command: b.input.command,
      }));
    },

    getText(content) {
      return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    },

    buildToolResult(toolCallId, output, isError) {
      return {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: output,
        ...(isError ? { is_error: true } : {}),
      };
    },

    buildAssistantMessage(content) {
      return { role: 'assistant', content };
    },

    buildToolResultsMessage(results) {
      return { role: 'user', content: results };
    },

    buildForceSummaryMessage() {
      return {
        role: 'user',
        content: 'Please summarize your findings based on the commands you have already run. Do not run any more commands.',
      };
    },
  };
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a backend instance.
 * @param {string} backendId - 'claude', 'vllm', or 'ollama'
 * @param {string} [model] - Optional model override
 * @returns {Object} Backend instance
 */
function createBackend(backendId, model) {
  if (backendId === 'claude') {
    return createClaudeBackend(model);
  }
  if (backendId === 'vllm' || backendId === 'ollama') {
    return createOpenAIBackend(backendId, model);
  }
  throw new Error(`Unknown backend: ${backendId}. Valid options: claude, vllm, ollama`);
}

module.exports = {
  BACKENDS,
  getAvailableBackends,
  createBackend,
};
