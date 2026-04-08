const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const sshManager = require('../lib/ssh-manager');
const { localExec } = require('../lib/local-exec');
const { requireCredentials, asyncHandler } = require('../lib/middleware');
const { getAvailableBackends, createBackend } = require('../lib/ai-backends');

// ─── Knowledge Base ──────────────────────────────────────────────────────────
let cachedKnowledgeBase = null;

function loadKnowledgeBase() {
  if (cachedKnowledgeBase) return cachedKnowledgeBase;

  try {
    const kbPath = path.join(__dirname, '..', 'knowledge-base.json');
    const kbContent = fs.readFileSync(kbPath, 'utf-8');
    const kb = JSON.parse(kbContent);

    let kbText = '\n\n=== BIZON KNOWLEDGE BASE (use these specific commands) ===\n';

    for (const [, category] of Object.entries(kb.categories || {})) {
      kbText += `\n[${category.title}]\n`;
      if (category.workflow) {
        kbText += `WORKFLOW: ${category.workflow.trigger}\n`;
        kbText += category.workflow.steps.join(' → ') + '\n';
      }
      for (const cmd of category.commands) {
        kbText += `• ${cmd.name}: ${cmd.command}\n`;
      }
      if (category.notes) {
        kbText += `NOTE: ${category.notes}\n`;
      }
    }

    if (kb.troubleshooting) {
      kbText += '\n[Troubleshooting]\n';
      for (const [issue, guide] of Object.entries(kb.troubleshooting)) {
        kbText += `• ${issue.replace(/_/g, ' ')}: ${guide.steps.slice(0, 3).join(' | ')}\n`;
      }
    }

    cachedKnowledgeBase = kbText;
    return kbText;
  } catch (error) {
    console.log('[Diagnostic] Knowledge base not found, using defaults');
    return '';
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are BizonAI, a hardware diagnostic assistant built into the Bizon Tech mobile app.
You help users diagnose and troubleshoot their Bizon AI workstations and GPU servers.

IMPORTANT: Use the MINIMUM number of commands needed to answer the user's question. Do NOT run unrelated commands.

Examples:
- "What GPUs are installed?" → Just run: nvidia-smi --query-gpu=name,memory.total --format=csv
- "Check CPU temp" → Just run: sensors | grep -E "Core|Tctl"
- "Any memory errors?" → Just run: sudo ras-mc-ctl --summary 2>/dev/null || echo "Not available"
- "Full diagnostic" → Run comprehensive checks (GPU, CPU, memory, storage, errors)

Command reference (use only what's needed):
- GPU info: nvidia-smi or nvidia-smi --query-gpu=name,memory.total,temperature.gpu --format=csv
- CPU info: lscpu | grep -E "Model|Core|Thread"
- CPU temp: sensors | grep -E "Core|Tctl|temp"
- Memory: free -h
- ECC errors: sudo ras-mc-ctl --summary 2>/dev/null
- Disk space: df -h | grep -v tmpfs
- Errors: sudo dmesg | grep -iE "error|fail" | tail -20
- PCI devices: lspci | grep -iE "nvidia|vga|nvme"

EFFICIENCY RULES:
1. Answer simple info questions with 1-2 commands max
2. Use grep/head/tail to limit output size
3. Only run error/log checks if user asks about errors or "full diagnostic"
4. Combine related checks into single commands when possible
5. Keep your responses concise — this is a mobile app with limited screen space

You have access to the run_ssh_command tool to execute commands on the workstation. Use it to gather information and diagnose issues.

After running commands, provide a clear summary of findings with any issues highlighted.`;

// ─── Quick Actions ───────────────────────────────────────────────────────────
const QUICK_ACTIONS = [
  {
    id: 'health-check',
    label: 'Health Check',
    description: 'Comprehensive system health scan',
    icon: 'heart-pulse',
    prompt: 'Run a quick health check on this machine. Check GPU status, CPU temperatures, memory status, and any recent errors in the system logs.',
  },
  {
    id: 'gpu-diagnostics',
    label: 'GPU Diagnostics',
    description: 'Check GPU temps, errors & utilization',
    icon: 'expansion-card',
    prompt: 'Run GPU diagnostics. Check nvidia-smi status, GPU temperatures, any Xid errors in dmesg, ECC memory errors on the GPUs, and current power draw vs limits.',
  },
  {
    id: 'memory-errors',
    label: 'Memory Errors',
    description: 'Check ECC & RAS memory errors',
    icon: 'memory',
    prompt: 'Check for memory errors on this system. Run ras-mc-ctl --errors, check dmesg for memory-related errors, and check EDAC status.',
  },
  {
    id: 'storage-health',
    label: 'Storage Health',
    description: 'NVMe & disk health check',
    icon: 'harddisk',
    prompt: 'Check the health of all storage devices. List NVMe drives, check SMART health status, and available disk space.',
  },
  {
    id: 'temperature-check',
    label: 'Temperatures',
    description: 'All CPU & GPU temperatures',
    icon: 'thermometer',
    prompt: 'Check all temperatures on this system. Get CPU core temperatures using sensors, GPU temperatures using nvidia-smi, and any IPMI sensor readings available.',
  },
  {
    id: 'error-scan',
    label: 'Error Scan',
    description: 'Scan logs for hardware errors',
    icon: 'alert-circle-outline',
    prompt: 'Scan the system for recent errors. Check dmesg for hardware errors, GPU Xid errors, PCI errors, and any critical messages in the last 100 lines.',
  },
];

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/diagnostic/quick-actions
router.get('/quick-actions', (req, res) => {
  res.json({ actions: QUICK_ACTIONS });
});

// GET /api/diagnostic/backends — list available AI backends
router.get('/backends', asyncHandler(async (req, res) => {
  const backends = await getAvailableBackends();
  res.json({ backends });
}));

// POST /api/diagnostic/chat
router.post('/chat', asyncHandler(async (req, res) => {
  const { username, password, messages, userId, sudoPassword, backend, model, systemPrompt: clientSystemPrompt } = req.body;
  const requestStart = Date.now();
  const REQUEST_TIMEOUT_MS = 90000;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // ─── Resolve backend ──────────────────────────────────────────────────
  const backendId = backend || 'claude'; // default to claude for backwards compatibility
  const validBackends = ['claude', 'vllm', 'ollama'];
  if (!validBackends.includes(backendId)) {
    return res.status(400).json({
      error: `Invalid backend: ${backendId}. Valid options: ${validBackends.join(', ')}`,
    });
  }

  // Validate backend-specific requirements
  if (backendId === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not configured on this workstation. Set it in the environment.',
    });
  }

  // For vllm/ollama — if no model specified, auto-detect from server
  let resolvedModel = model || null;
  if ((backendId === 'vllm' || backendId === 'ollama') && !resolvedModel) {
    try {
      const backends = await getAvailableBackends();
      const info = backends[backendId];
      if (!info || !info.available) {
        return res.status(503).json({
          error: `${backendId} backend is not available. Make sure the server is running.`,
          hint: backendId === 'vllm'
            ? 'Start vLLM with: conda activate vllm_env && vllm serve <model>'
            : 'Start Ollama with: ollama serve, then pull a model: ollama pull <model>',
        });
      }
      resolvedModel = info.defaultModel;
    } catch (err) {
      return res.status(503).json({
        error: `Could not connect to ${backendId} backend: ${err.message}`,
      });
    }
  }

  const userKey = userId || req.ip || 'anonymous';
  console.log(`[Diagnostic] Chat request from ${userKey}, backend=${backendId}, model=${resolvedModel || 'default'}, ${messages.length} messages`);

  // Create the AI backend
  let ai;
  try {
    ai = createBackend(backendId, resolvedModel);
  } catch (err) {
    return res.status(500).json({ error: `Failed to create ${backendId} backend: ${err.message}` });
  }

  // Set up NDJSON streaming response
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const sendEvent = (data) => { try { res.write(JSON.stringify(data) + '\n'); } catch(e) {} };

  // Build system prompt with knowledge base
  // If the client sent a systemPrompt (managed via the desktop app repo), use it;
  // otherwise fall back to the server's default SYSTEM_PROMPT.
  const basePrompt = (clientSystemPrompt && clientSystemPrompt.trim()) ? clientSystemPrompt.trim() : SYSTEM_PROMPT;
  const knowledgeBase = loadKnowledgeBase();
  const fullSystemPrompt = basePrompt + knowledgeBase;

  // Limit conversation history to last 10 messages
  const recentMessages = messages
    .slice(-10)
    .filter(msg => msg.content && msg.content.trim() !== '')
    .map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    }));

  // Track usage
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const toolCallsExecuted = [];
  const MAX_TOOL_ITERATIONS = 10;
  let iterations = 0;

  try {
    sendEvent({ type: 'status', message: `Connecting to ${backendId}...` });

    // Initial AI call
    let response = await ai.chat(fullSystemPrompt, recentMessages, true);

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    cacheReadTokens += response.usage.cacheReadTokens;
    cacheCreationTokens += response.usage.cacheCreationTokens;

    // Agentic tool use loop
    const conversationHistory = [...recentMessages];

    while (response.stopReason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
      if (Date.now() - requestStart > REQUEST_TIMEOUT_MS) {
        console.log(`[Diagnostic] Request timeout reached at iteration ${iterations}, forcing summary`);
        break;
      }
      iterations++;

      const toolCalls = ai.getToolCalls(response.content);
      if (toolCalls.length === 0) break;

      conversationHistory.push(ai.buildAssistantMessage(response.content));

      const toolResults = [];

      for (const toolCall of toolCalls) {
        const command = toolCall.command;
        console.log(`[Diagnostic] [${backendId}] Tool call ${iterations}: ${command}`);
        sendEvent({ type: 'command', command, iteration: iterations });

        const startTime = Date.now();
        const timeout = command.includes('docker') ? 120000 : 30000;

        try {
          // SSH mode (mobile app sends credentials) vs local mode (desktop app)
          let result;
          if (username && password) {
            const conn = await sshManager.getConnection(username, password);
            // Auto-elevate known privileged commands when sudoPassword is available
            const SUDO_COMMANDS = ['dmesg', 'dmidecode', 'ras-mc-ctl', 'journalctl', 'smartctl', 'hdparm', 'lshw'];
            const needsSudo = sudoPassword && !command.trim().startsWith('sudo') &&
              SUDO_COMMANDS.some(c => command.trim().startsWith(c));
            if ((command.trim().startsWith('sudo') || needsSudo) && sudoPassword) {
              const sudoCmd = command.replace(/^sudo\s+/, '');
              result = await sshManager.execSudo(conn, sudoCmd, sudoPassword);
            } else {
              result = await sshManager.exec(conn, command, timeout);
            }
          } else {
            result = await localExec(command, timeout);
          }

          const duration = Date.now() - startTime;
          toolCallsExecuted.push({ command, duration });
          sendEvent({ type: 'command_done', command, duration });

          const output = (result.output || '') + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
          toolResults.push(ai.buildToolResult(toolCall.id, output || '(no output)', false));
        } catch (err) {
          const duration = Date.now() - startTime;
          toolCallsExecuted.push({ command, duration });
          sendEvent({ type: 'command_done', command, duration, error: err.message });

          toolResults.push(ai.buildToolResult(toolCall.id, `Error executing command: ${err.message}`, true));
        }
      }

      conversationHistory.push(ai.buildToolResultsMessage(toolResults));

      // Continue conversation with tool results
      sendEvent({ type: 'status', message: 'AI is analyzing results...' });
      response = await ai.chat(fullSystemPrompt, conversationHistory, true);

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
      cacheReadTokens += response.usage.cacheReadTokens;
      cacheCreationTokens += response.usage.cacheCreationTokens;
    }

    // If still wants tools after max iterations, force text response
    if (response.stopReason === 'tool_use') {
      console.log('[Diagnostic] Max iterations reached, forcing summary');
      conversationHistory.push(ai.buildAssistantMessage(response.content));
      conversationHistory.push(ai.buildForceSummaryMessage());

      response = await ai.chat(fullSystemPrompt, conversationHistory, false);

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
    }

    // Extract final text
    const finalText = ai.getText(response.content);

    console.log(`[Diagnostic] [${backendId}] Done: ${totalInputTokens} in, ${totalOutputTokens} out, ${toolCallsExecuted.length} commands, cache read: ${cacheReadTokens}`);

    sendEvent({
      type: 'result',
      content: finalText,
      backend: backendId,
      model: resolvedModel || 'default',
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        toolCalls: toolCallsExecuted.length,
        iterations,
      },
      toolCalls: toolCallsExecuted,
    });
    res.end();
  } catch (error) {
    console.error(`[Diagnostic] [${backendId}] API error:`, error.message);

    sendEvent({ type: 'error', error: error.message || 'Diagnostic chat failed', backend: backendId });
    res.end();
  }
}));

module.exports = router;
