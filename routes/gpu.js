const express = require('express');
const router = express.Router();
const ssh = require('../lib/ssh-manager');
const { requireCredentials, asyncHandler } = require('../lib/middleware');

/**
 * POST /api/gpu-status
 * Get real-time GPU metrics: temperature, utilization, power, memory, clocks.
 */
router.post('/gpu-status', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    names: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo ""',
    temps: 'nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null || echo ""',
    utilization: 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader 2>/dev/null || echo ""',
    memoryUtil: 'nvidia-smi --query-gpu=utilization.memory --format=csv,noheader 2>/dev/null || echo ""',
    powerDraw: 'nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null || echo ""',
    powerLimit: 'nvidia-smi --query-gpu=power.limit --format=csv,noheader 2>/dev/null || echo ""',
    powerDefaultLimit: 'nvidia-smi --query-gpu=power.default_limit --format=csv,noheader 2>/dev/null || echo ""',
    powerMaxLimit: 'nvidia-smi --query-gpu=power.max_limit --format=csv,noheader 2>/dev/null || echo ""',
    powerMinLimit: 'nvidia-smi --query-gpu=power.min_limit --format=csv,noheader 2>/dev/null || echo ""',
    memoryTotal: 'nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo ""',
    memoryUsed: 'nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo ""',
    memoryFree: 'nvidia-smi --query-gpu=memory.free --format=csv,noheader 2>/dev/null || echo ""',
    fanSpeed: 'nvidia-smi --query-gpu=fan.speed --format=csv,noheader 2>/dev/null || echo ""',
    clockSm: 'nvidia-smi --query-gpu=clocks.current.sm --format=csv,noheader 2>/dev/null || echo ""',
    clockMem: 'nvidia-smi --query-gpu=clocks.current.memory --format=csv,noheader 2>/dev/null || echo ""',
    driver: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || echo ""',
    cudaVersion: 'nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 || echo ""',
    perfState: 'nvidia-smi --query-gpu=pstate --format=csv,noheader 2>/dev/null || echo ""',
  };

  const results = await ssh.execMultiple(conn, commands);
  const lines = (key) => (results[key]?.output || '').split('\n').filter(l => l.trim());

  const names = lines('names');
  const gpuCount = names.length;

  const gpus = [];
  for (let i = 0; i < gpuCount; i++) {
    gpus.push({
      index: i,
      name: names[i]?.trim() || 'Unknown',
      temperature: {
        current: lines('temps')[i]?.trim() || 'N/A',
        unit: '°C',
      },
      utilization: {
        gpu: lines('utilization')[i]?.trim() || 'N/A',
        memory: lines('memoryUtil')[i]?.trim() || 'N/A',
      },
      power: {
        draw: lines('powerDraw')[i]?.trim() || 'N/A',
        limit: lines('powerLimit')[i]?.trim() || 'N/A',
        defaultLimit: lines('powerDefaultLimit')[i]?.trim() || 'N/A',
        maxLimit: lines('powerMaxLimit')[i]?.trim() || 'N/A',
        minLimit: lines('powerMinLimit')[i]?.trim() || 'N/A',
      },
      memory: {
        total: lines('memoryTotal')[i]?.trim() || 'N/A',
        used: lines('memoryUsed')[i]?.trim() || 'N/A',
        free: lines('memoryFree')[i]?.trim() || 'N/A',
      },
      fan: {
        speed: lines('fanSpeed')[i]?.trim() || 'N/A',
      },
      clocks: {
        sm: lines('clockSm')[i]?.trim() || 'N/A',
        memory: lines('clockMem')[i]?.trim() || 'N/A',
      },
      performanceState: lines('perfState')[i]?.trim() || 'N/A',
    });
  }

  res.json({
    count: gpuCount,
    driver: results.driver?.output?.trim() || 'Unknown',
    gpus,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/gpu-processes
 * Get running GPU processes.
 */
router.post('/gpu-processes', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const result = await ssh.exec(conn, 
    'nvidia-smi --query-compute-apps=pid,name,gpu_uuid,used_memory --format=csv,noheader 2>/dev/null || echo ""'
  );

  const processes = [];
  if (result.output) {
    result.output.split('\n').forEach(line => {
      if (line.trim()) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length >= 4) {
          processes.push({
            pid: parts[0],
            name: parts[1],
            gpuUuid: parts[2],
            memoryUsed: parts[3],
          });
        }
      }
    });
  }

  res.json({ processes, timestamp: new Date().toISOString() });
}));

/**
 * POST /api/set-gpu-power-limit
 * Set GPU power limit (requires sudo).
 */
router.post('/set-gpu-power-limit', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password, sudoPassword, watts, gpuIndex } = req.body;

  if (!sudoPassword) {
    return res.status(400).json({ error: 'sudoPassword is required for this operation' });
  }
  if (watts === undefined || watts === null || isNaN(Number(watts))) {
    return res.status(400).json({ error: 'A valid watts value is required' });
  }

  const conn = await ssh.getConnection(username, password);
  
  // Build the command — either for a specific GPU or all GPUs
  const gpuFlag = gpuIndex !== undefined ? `-i ${parseInt(gpuIndex)}` : '';
  const command = `nvidia-smi ${gpuFlag} -pl ${parseInt(watts)}`;
  
  const result = await ssh.execSudo(conn, command, sudoPassword);

  if (result.exitCode === 0) {
    res.json({ success: true, message: `Power limit set to ${watts}W`, output: result.output });
  } else {
    res.status(400).json({ success: false, error: 'Failed to set power limit', output: result.output, stderr: result.stderr });
  }
}));

/**
 * POST /api/set-fan-speed
 * Set fan speed (requires sudo and nvidia-settings or IPMI).
 */
router.post('/set-fan-speed', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password, sudoPassword, speed, gpuIndex } = req.body;

  if (!sudoPassword) {
    return res.status(400).json({ error: 'sudoPassword is required for this operation' });
  }
  if (speed === undefined || speed === null || isNaN(Number(speed)) || speed < 0 || speed > 100) {
    return res.status(400).json({ error: 'A valid speed value (0-100) is required' });
  }

  const conn = await ssh.getConnection(username, password);

  // Enable manual fan control and set speed using nvidia-settings
  const gpuIdx = gpuIndex !== undefined ? parseInt(gpuIndex) : 0;
  const commands = [
    `nvidia-settings -a "[gpu:${gpuIdx}]/GPUFanControlState=1"`,
    `nvidia-settings -a "[fan:${gpuIdx}]/GPUTargetFanSpeed=${parseInt(speed)}"`,
  ];

  const fullCommand = commands.join(' && ');
  const result = await ssh.execSudo(conn, fullCommand, sudoPassword);

  if (result.exitCode === 0) {
    res.json({ success: true, message: `Fan speed set to ${speed}%`, output: result.output });
  } else {
    // Fallback: Try IPMI if nvidia-settings fails
    const ipmiResult = await ssh.execSudo(
      conn,
      `ipmitool raw 0x30 0x30 0x02 0xff ${parseInt(speed).toString(16)}`,
      sudoPassword
    ).catch(() => null);

    if (ipmiResult && ipmiResult.exitCode === 0) {
      res.json({ success: true, message: `Fan speed set to ${speed}% via IPMI`, output: ipmiResult.output });
    } else {
      res.status(400).json({ success: false, error: 'Failed to set fan speed', output: result.output, stderr: result.stderr });
    }
  }
}));

module.exports = router;
