const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');
const sshManager = require('../lib/ssh-manager');
const { requireCredentials, asyncHandler } = require('../lib/middleware');

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const DAILY_LIMIT = 5;
const rateLimitFile = path.join(__dirname, '..', 'rate-limits.json');

function loadRateLimits() {
  try {
    if (fs.existsSync(rateLimitFile)) {
      return JSON.parse(fs.readFileSync(rateLimitFile, 'utf-8'));
    }
  } catch (e) {
    console.error('[Diagnostic] Error loading rate limits:', e.message);
  }
  return {};
}

function saveRateLimits(limits) {
  try {
    fs.writeFileSync(rateLimitFile, JSON.stringify(limits, null, 2));
  } catch (e) {
    console.error('[Diagnostic] Error saving rate limits:', e.message);
  }
}

function checkRateLimit(userId) {
  const limits = loadRateLimits();
  const today = new Date().toISOString().split('T')[0];
  const userLimit = limits[userId];

  if (!userLimit || userLimit.date !== today) {
    return { allowed: true, remaining: DAILY_LIMIT, total: DAILY_LIMIT };
  }

  const remaining = Math.max(0, DAILY_LIMIT - userLimit.count);
  return { allowed: remaining > 0, remaining, total: DAILY_LIMIT };
}

function incrementRateLimit(userId) {
  const limits = loadRateLimits();
  const today = new Date().toISOString().split('T')[0];

  if (!limits[userId] || limits[userId].date !== today) {
    limits[userId] = { date: today, count: 1 };
  } else {
    limits[userId].count += 1;
  }

  saveRateLimits(limits);
  return DAILY_LIMIT - limits[userId].count;
}

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
- Errors: dmesg | grep -iE "error|fail" | tail -20
- PCI devices: lspci | grep -iE "nvidia|vga|nvme"

EFFICIENCY RULES:
1. Answer simple info questions with 1-2 commands max
2. Use grep/head/tail to limit output size
3. Only run error/log checks if user asks about errors or "full diagnostic"
4. Combine related checks into single commands when possible
5. Keep your responses concise — this is a mobile app with limited screen space

After running commands, provide a clear summary of findings with any issues highlighted.`;

// ─── SSH Tool Definition ─────────────────────────────────────────────────────
const SSH_TOOL = {
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

// GET /api/diagnostic/rate-limit/:userId
router.get('/rate-limit/:userId', (req, res) => {
  const { userId } = req.params;
  const limit = checkRateLimit(userId);
  res.json({
    remaining: limit.remaining,
    total: limit.total,
    resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
  });
});

// POST /api/diagnostic/chat
router.post('/chat', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password, messages, userId, sudoPassword } = req.body;
  const requestStart = Date.now();
  const REQUEST_TIMEOUT_MS = 90000; // 90s hard cap — mobile app uses 120s timeout

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on this workstation. Set it in the environment.' });
  }

  // Rate limit check
  const userKey = userId || req.ip || 'anonymous';
  const rateLimit = checkRateLimit(userKey);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: 'Daily diagnostic limit reached (5/day). Try again tomorrow.',
      rateLimit: {
        remaining: 0,
        total: DAILY_LIMIT,
        resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
      },
    });
  }

  console.log(`[Diagnostic] Chat request from ${userKey}, ${messages.length} messages`);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Set up NDJSON streaming response
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const sendEvent = (data) => { try { res.write(JSON.stringify(data) + '\n'); } catch(e) {} };

  // Build system prompt with knowledge base (cached)
  const knowledgeBase = loadKnowledgeBase();
  const fullSystemPrompt = SYSTEM_PROMPT + knowledgeBase;

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
    sendEvent({ type: 'status', message: 'Connecting to AI...' });

    // Initial Claude call with prompt caching
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: fullSystemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: recentMessages,
      tools: [SSH_TOOL],
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    if (response.usage.cache_read_input_tokens) {
      cacheReadTokens += response.usage.cache_read_input_tokens;
    }
    if (response.usage.cache_creation_input_tokens) {
      cacheCreationTokens += response.usage.cache_creation_input_tokens;
    }

    // Agentic tool use loop
    const conversationHistory = [...recentMessages];

    while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
      // Hard timeout check — bail out if approaching the limit
      if (Date.now() - requestStart > REQUEST_TIMEOUT_MS) {
        console.log(`[Diagnostic] Request timeout reached at iteration ${iterations}, forcing summary`);
        break;
      }
      iterations++;

      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      conversationHistory.push({ role: 'assistant', content: response.content });

      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === 'run_ssh_command') {
          const command = toolUse.input.command;
          console.log(`[Diagnostic] Tool call ${iterations}: ${command}`);
          sendEvent({ type: 'command', command, iteration: iterations });

          const startTime = Date.now();
          const timeout = command.includes('docker') ? 120000 : 30000;

          try {
            const conn = await sshManager.getConnection(username, password);
            let result;
            // Handle sudo commands
            if (command.trim().startsWith('sudo') && sudoPassword) {
              const sudoCmd = command.replace(/^sudo\s+/, '');
              result = await sshManager.execSudo(conn, sudoCmd, sudoPassword);
            } else {
              result = await sshManager.exec(conn, command, timeout);
            }

            const duration = Date.now() - startTime;
            toolCallsExecuted.push({ command, duration });
            sendEvent({ type: 'command_done', command, duration });

            const output = (result.output || '') + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: output || '(no output)',
            });
          } catch (err) {
            const duration = Date.now() - startTime;
            toolCallsExecuted.push({ command, duration });
            sendEvent({ type: 'command_done', command, duration, error: err.message });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error executing command: ${err.message}`,
              is_error: true,
            });
          }
        }
      }

      conversationHistory.push({ role: 'user', content: toolResults });

      // Continue conversation with tool results (cached system prompt)
      sendEvent({ type: 'status', message: 'AI is analyzing results...' });
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: fullSystemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: conversationHistory,
        tools: [SSH_TOOL],
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      if (response.usage.cache_read_input_tokens) {
        cacheReadTokens += response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens) {
        cacheCreationTokens += response.usage.cache_creation_input_tokens;
      }
    }

    // If still wants tools after max iterations, force text response
    if (response.stop_reason === 'tool_use') {
      console.log('[Diagnostic] Max iterations reached, forcing summary');
      conversationHistory.push({ role: 'assistant', content: response.content });
      conversationHistory.push({
        role: 'user',
        content: 'Please summarize your findings based on the commands you have already run. Do not run any more commands.',
      });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: fullSystemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: conversationHistory,
        // No tools — forces text response
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
    }

    // Extract final text
    const textBlocks = response.content.filter(block => block.type === 'text');
    const finalText = textBlocks.map(block => block.text).join('\n');

    // Increment rate limit on success
    const remaining = incrementRateLimit(userKey);

    console.log(`[Diagnostic] Done: ${totalInputTokens} in, ${totalOutputTokens} out, ${toolCallsExecuted.length} commands, cache read: ${cacheReadTokens}`);

    sendEvent({
      type: 'result',
      content: finalText,
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
      rateLimit: {
        remaining,
        total: DAILY_LIMIT,
        resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
      },
    });
    res.end();
  } catch (error) {
    console.error('[Diagnostic] Claude API error:', error.message);

    sendEvent({ type: 'error', error: error.message || 'Diagnostic chat failed' });
    res.end();
  }
}));

module.exports = router;
