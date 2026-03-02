const express = require('express');
const router = express.Router();
const ssh = require('../lib/ssh-manager');
const { requireCredentials, asyncHandler } = require('../lib/middleware');

/**
 * POST /api/processes
 * Get running processes sorted by CPU/memory usage.
 */
router.post('/processes', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const { sortBy = 'cpu', limit = 20 } = req.body;
  const conn = await ssh.getConnection(username, password);

  const sortFlag = sortBy === 'memory' ? '--sort=-%mem' : '--sort=-%cpu';
  const result = await ssh.exec(conn,
    `ps aux ${sortFlag} | head -n ${parseInt(limit) + 1}`
  );

  const lines = result.output.split('\n');
  const header = lines[0];
  const processes = lines.slice(1).filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      user: parts[0],
      pid: parts[1],
      cpu: parts[2],
      memory: parts[3],
      vsz: parts[4],
      rss: parts[5],
      tty: parts[6],
      stat: parts[7],
      start: parts[8],
      time: parts[9],
      command: parts.slice(10).join(' '),
    };
  });

  res.json({ processes, timestamp: new Date().toISOString() });
}));

/**
 * POST /api/disk-usage
 * Get disk usage information.
 */
router.post('/disk-usage', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    df: 'df -h --output=source,size,used,avail,pcent,target | grep -v tmpfs | grep -v udev',
    lsblk: 'lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE -J 2>/dev/null || lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE',
    ioStats: 'iostat -d -x 1 1 2>/dev/null | tail -n +4 || echo ""',
  };

  const results = await ssh.execMultiple(conn, commands);

  // Parse df output
  const filesystems = [];
  if (results.df.output) {
    const lines = results.df.output.split('\n');
    lines.slice(1).forEach(line => {
      if (line.trim()) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          filesystems.push({
            device: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            usePercent: parts[4],
            mountPoint: parts[5],
          });
        }
      }
    });
  }

  // Parse lsblk if JSON
  let blockDevices = [];
  try {
    const parsed = JSON.parse(results.lsblk.output);
    blockDevices = parsed.blockdevices || [];
  } catch {
    // Non-JSON fallback
    if (results.lsblk.output) {
      const lines = results.lsblk.output.split('\n');
      lines.slice(1).forEach(line => {
        if (line.trim()) {
          const parts = line.trim().split(/\s+/);
          blockDevices.push({
            name: parts[0]?.replace(/[├─└│]/g, '').trim(),
            size: parts[1],
            type: parts[2],
            mountpoint: parts[3] || null,
            fstype: parts[4] || null,
          });
        }
      });
    }
  }

  res.json({
    filesystems,
    blockDevices,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/network-stats
 * Get network statistics and active connections.
 */
router.post('/network-stats', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    interfaces: 'ip -j addr show 2>/dev/null || ip addr show',
    routes: 'ip -j route show default 2>/dev/null || ip route show default',
    connections: 'ss -tunp | head -30',
    bandwidth: 'cat /proc/net/dev | grep -v "lo:" | grep -v "Inter" | grep -v "face"',
    dns: 'cat /etc/resolv.conf | grep nameserver | awk \'{print $2}\'',
  };

  const results = await ssh.execMultiple(conn, commands);

  // Parse network interfaces
  let interfaces = [];
  try {
    interfaces = JSON.parse(results.interfaces.output);
  } catch {
    // Fallback parsing for non-JSON output
    if (results.interfaces.output) {
      const blocks = results.interfaces.output.split(/^\d+: /m).filter(b => b.trim());
      interfaces = blocks.map(block => {
        const nameMatch = block.match(/^(\S+)/);
        const ipMatch = block.match(/inet\s+([\d.]+)/);
        return {
          name: nameMatch ? nameMatch[1].replace(':', '') : 'unknown',
          ip: ipMatch ? ipMatch[1] : null,
        };
      });
    }
  }

  // Parse bandwidth from /proc/net/dev
  const bandwidthStats = [];
  if (results.bandwidth.output) {
    results.bandwidth.output.split('\n').forEach(line => {
      if (line.trim()) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10) {
          bandwidthStats.push({
            interface: parts[0].replace(':', ''),
            rxBytes: parseInt(parts[1]),
            txBytes: parseInt(parts[9]),
          });
        }
      }
    });
  }

  // Parse DNS
  const dns = results.dns.output ? results.dns.output.split('\n').filter(l => l.trim()) : [];

  res.json({
    interfaces,
    bandwidthStats,
    dns,
    activeConnections: results.connections.output,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/system-health
 * Get overall system health metrics (CPU usage, load, memory, temps).
 */
router.post('/system-health', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    loadAvg: 'cat /proc/loadavg',
    cpuUsage: 'top -bn1 | grep "Cpu(s)" | awk \'{print $2}\'',
    memInfo: 'free -h | grep Mem | awk \'{print $2, $3, $4, $7}\'',
    swapInfo: 'free -h | grep Swap | awk \'{print $2, $3, $4}\'',
    uptime: 'uptime -p',
    cpuTemp: 'sensors 2>/dev/null | grep "Core 0" | awk \'{print $3}\' | head -1 || echo "N/A"',
    gpuTemp: 'nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null || echo ""',
    gpuUtil: 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader 2>/dev/null || echo ""',
    gpuPower: 'nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null || echo ""',
    diskUsage: 'df -h / | tail -1 | awk \'{print $5}\'',
    waterTemp: 'bizon-cooling-status temp 2>/dev/null || echo "N/A"',
  };

  const results = await ssh.execMultiple(conn, commands);
  const r = (key) => results[key]?.output || 'N/A';

  // Parse load average
  const loadParts = r('loadAvg').split(' ');
  const load = {
    '1min': loadParts[0] || 'N/A',
    '5min': loadParts[1] || 'N/A',
    '15min': loadParts[2] || 'N/A',
  };

  // Parse memory
  const memParts = r('memInfo').split(' ');
  const memory = {
    total: memParts[0] || 'N/A',
    used: memParts[1] || 'N/A',
    free: memParts[2] || 'N/A',
    available: memParts[3] || 'N/A',
  };

  // Parse swap
  const swapParts = r('swapInfo').split(' ');
  const swap = {
    total: swapParts[0] || 'N/A',
    used: swapParts[1] || 'N/A',
    free: swapParts[2] || 'N/A',
  };

  // Parse GPU temps
  const gpuTemps = r('gpuTemp').split('\n').filter(l => l.trim()).map(t => `${t.trim()}°C`);
  const gpuUtils = r('gpuUtil').split('\n').filter(l => l.trim());
  const gpuPowers = r('gpuPower').split('\n').filter(l => l.trim());

  res.json({
    cpu: {
      usage: r('cpuUsage'),
      temperature: r('cpuTemp'),
      load,
    },
    memory,
    swap,
    gpu: {
      temperatures: gpuTemps,
      utilizations: gpuUtils,
      powerDraw: gpuPowers,
    },
    disk: {
      rootUsage: r('diskUsage'),
    },
    cooling: {
      waterTemperature: r('waterTemp'),
    },
    uptime: r('uptime'),
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/reboot
 * Reboot the machine (requires sudo).
 */
router.post('/reboot', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password, sudoPassword } = req.body;

  if (!sudoPassword) {
    return res.status(400).json({ error: 'sudoPassword is required for reboot' });
  }

  const conn = await ssh.getConnection(username, password);
  const result = await ssh.execSudo(conn, 'reboot', sudoPassword);

  res.json({
    success: result.exitCode === 0,
    message: result.exitCode === 0 ? 'Reboot command sent successfully' : 'Failed to reboot',
    output: result.output,
  });
}));

/**
 * POST /api/shutdown
 * Shutdown the machine (requires sudo).
 */
router.post('/shutdown', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password, sudoPassword } = req.body;

  if (!sudoPassword) {
    return res.status(400).json({ error: 'sudoPassword is required for shutdown' });
  }

  const conn = await ssh.getConnection(username, password);
  const result = await ssh.execSudo(conn, 'shutdown -h now', sudoPassword);

  res.json({
    success: result.exitCode === 0,
    message: result.exitCode === 0 ? 'Shutdown command sent successfully' : 'Failed to shutdown',
    output: result.output,
  });
}));

module.exports = router;
