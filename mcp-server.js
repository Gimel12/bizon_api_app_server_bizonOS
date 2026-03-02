#!/usr/bin/env node

/**
 * Bizon Tech MCP Server
 * 
 * Exposes workstation management capabilities as MCP tools so AI models
 * can take actions on Bizon-Tech workstations and servers.
 * 
 * Supports both stdio transport (for local AI integrations) and
 * SSE transport (for remote/network AI integrations).
 * 
 * Usage:
 *   stdio:  node mcp-server.js --transport stdio
 *   sse:    node mcp-server.js --transport sse --port 4001
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');
const express = require('express');
const ssh = require('./lib/ssh-manager');

// ─── Create MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: 'bizon-workstation',
  version: '2.0.0',
  description: 'Bizon-Tech Workstation Management — control and monitor AI workstations and GPU servers',
});

// ─── Credential Schema (reused across tools) ────────────────────────────────

const credentialsSchema = {
  username: z.string().describe('SSH username for the workstation'),
  password: z.string().describe('SSH password for the workstation'),
};

const sudoSchema = {
  ...credentialsSchema,
  sudoPassword: z.string().describe('Sudo password for privileged operations'),
};

// ─── Tool: get_system_info ──────────────────────────────────────────────────

server.tool(
  'get_system_info',
  'Get basic system information from the workstation including hostname, CPU, memory, GPUs, kernel version, and BizonOS version',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);

    const commands = {
      uname: 'uname -a',
      hostname: 'hostname',
      cpu: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
      memory: 'free -h | grep Mem | awk \'{print $2}\'',
      gpu: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "No GPUs"',
      kernel: 'uname -r',
      bizonos: 'cat /etc/bizonos-version 2>/dev/null || bizonos 2>/dev/null || echo "Unknown"',
      uptime: 'uptime -p',
      ip: 'hostname -I | awk \'{print $1}\'',
    };

    const results = await ssh.execMultiple(conn, commands);
    const r = (key) => results[key]?.output || 'Unknown';

    const gpuList = r('gpu').split('\n').filter(l => l.trim() && l !== 'No GPUs');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hostname: r('hostname'),
          cpu: r('cpu'),
          memory: r('memory'),
          gpus: gpuList.length > 0 ? `${gpuList.length}x ${gpuList[0]}` : 'No GPUs detected',
          gpuList,
          kernel: r('kernel'),
          bizonos: r('bizonos'),
          uptime: r('uptime'),
          ip: r('ip'),
          uname: r('uname'),
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_detailed_specs ───────────────────────────────────────────────

server.tool(
  'get_detailed_specs',
  'Get comprehensive hardware specifications including CPU details, memory slots, GPU VRAM, storage devices, network interfaces, cooling system status, and physical chassis info',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);

    const commands = {
      hostname: 'hostname',
      kernel: 'uname -r',
      os: 'lsb_release -ds 2>/dev/null || cat /etc/*release | grep "PRETTY_NAME" | sed \'s/PRETTY_NAME=//\' | tr -d \'"\' || echo "Unknown"',
      bizonos: 'cat /etc/bizonos-version 2>/dev/null || bizonos 2>/dev/null || echo "Unknown"',
      uptime: 'uptime -p',
      cpu_model: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
      cpu_cores: 'nproc',
      cpu_threads: 'lscpu | grep "^CPU(s):" | awk \'{print $2}\'',
      cpu_arch: 'lscpu | grep "Architecture" | awk \'{print $2}\'',
      cpu_freq: 'lscpu | grep "CPU max MHz" | awk \'{print $4}\'',
      cpu_cache: 'lscpu | grep "L3 cache" | sed "s/L3 cache://g" | xargs',
      mem_total: 'free -h | grep "Mem:" | awk \'{print $2}\'',
      gpu_names: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo ""',
      gpu_vram: 'nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo ""',
      gpu_driver: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || echo ""',
      storage: 'lsblk -d -o NAME,SIZE,MODEL | grep -v "loop" | grep -v "NAME" || echo ""',
      disk_usage: 'df -h / | tail -1 | awk \'{print $2, "total,", $3, "used,", $4, "free,", $5, "used"}\'',
      net_interfaces: 'ip -o link show | grep -v "lo:" | awk -F": " \'{print $2}\'',
      primary_ip: 'hostname -I | awk \'{print $1}\'',
      cpu_temp: 'sensors 2>/dev/null | grep "Core 0" | awk \'{print $3}\' | head -1 || echo "N/A"',
      water_temp: 'bizon-cooling-status temp 2>/dev/null || echo "N/A"',
      water_flow: 'bizon-cooling-status flow 2>/dev/null || echo "N/A"',
      pump_rpm: 'bizon-cooling-status pump 2>/dev/null || echo "N/A"',
    };

    const results = await ssh.execMultiple(conn, commands);
    const r = (key) => results[key]?.output || 'N/A';

    // Parse GPUs
    const gpuNames = r('gpu_names').split('\n').filter(l => l.trim());
    const gpuVram = r('gpu_vram').split('\n').filter(l => l.trim());
    const gpus = gpuNames.map((name, i) => ({
      name: name.trim(),
      vram: gpuVram[i]?.trim() || 'Unknown',
    }));

    // Parse storage
    const storageDevices = r('storage').split('\n').filter(l => l.trim()).map(line => {
      const parts = line.trim().split(/\s+/);
      return { device: parts[0], size: parts[1], model: parts.slice(2).join(' ') };
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          system: { hostname: r('hostname'), kernel: r('kernel'), os: r('os'), bizonos: r('bizonos'), uptime: r('uptime'), ip: r('primary_ip') },
          processor: { model: r('cpu_model'), cores: r('cpu_cores'), threads: r('cpu_threads'), architecture: r('cpu_arch'), maxFrequency: r('cpu_freq') !== 'N/A' ? `${Math.round(parseFloat(r('cpu_freq')) / 1000)} GHz` : 'N/A', cache: r('cpu_cache'), temperature: r('cpu_temp') },
          memory: { total: r('mem_total') },
          graphics: { count: gpus.length, gpus, driver: r('gpu_driver') },
          storage: { devices: storageDevices, rootPartition: r('disk_usage') },
          network: { interfaces: r('net_interfaces').split('\n').filter(l => l.trim()), primaryIp: r('primary_ip') },
          cooling: { cpuTemperature: r('cpu_temp'), waterTemperature: r('water_temp'), waterFlow: r('water_flow'), pumpSpeed: r('pump_rpm') },
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_gpu_status ───────────────────────────────────────────────────

server.tool(
  'get_gpu_status',
  'Get real-time GPU metrics including temperature, utilization, power draw, memory usage, fan speed, and clock speeds for all GPUs',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);

    const commands = {
      names: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo ""',
      temps: 'nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null || echo ""',
      util: 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader 2>/dev/null || echo ""',
      memUtil: 'nvidia-smi --query-gpu=utilization.memory --format=csv,noheader 2>/dev/null || echo ""',
      powerDraw: 'nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null || echo ""',
      powerLimit: 'nvidia-smi --query-gpu=power.limit --format=csv,noheader 2>/dev/null || echo ""',
      memTotal: 'nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo ""',
      memUsed: 'nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo ""',
      fan: 'nvidia-smi --query-gpu=fan.speed --format=csv,noheader 2>/dev/null || echo ""',
      clockSm: 'nvidia-smi --query-gpu=clocks.current.sm --format=csv,noheader 2>/dev/null || echo ""',
      clockMem: 'nvidia-smi --query-gpu=clocks.current.memory --format=csv,noheader 2>/dev/null || echo ""',
      pstate: 'nvidia-smi --query-gpu=pstate --format=csv,noheader 2>/dev/null || echo ""',
      driver: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || echo ""',
    };

    const results = await ssh.execMultiple(conn, commands);
    const lines = (key) => (results[key]?.output || '').split('\n').filter(l => l.trim());

    const names = lines('names');
    const gpus = names.map((name, i) => ({
      index: i,
      name: name.trim(),
      temperature: `${lines('temps')[i]?.trim() || 'N/A'}°C`,
      gpuUtilization: lines('util')[i]?.trim() || 'N/A',
      memoryUtilization: lines('memUtil')[i]?.trim() || 'N/A',
      powerDraw: lines('powerDraw')[i]?.trim() || 'N/A',
      powerLimit: lines('powerLimit')[i]?.trim() || 'N/A',
      memoryTotal: lines('memTotal')[i]?.trim() || 'N/A',
      memoryUsed: lines('memUsed')[i]?.trim() || 'N/A',
      fanSpeed: lines('fan')[i]?.trim() || 'N/A',
      clockSm: lines('clockSm')[i]?.trim() || 'N/A',
      clockMemory: lines('clockMem')[i]?.trim() || 'N/A',
      performanceState: lines('pstate')[i]?.trim() || 'N/A',
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: gpus.length,
          driver: results.driver?.output?.trim() || 'Unknown',
          gpus,
          timestamp: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_system_health ────────────────────────────────────────────────

server.tool(
  'get_system_health',
  'Get overall system health: CPU usage, load averages, memory usage, swap, GPU temps, disk usage, and cooling status',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);

    const commands = {
      loadAvg: 'cat /proc/loadavg',
      cpuUsage: 'top -bn1 | grep "Cpu(s)" | awk \'{print $2}\'',
      memInfo: 'free -h | grep Mem | awk \'{print "total:" $2, "used:" $3, "free:" $4, "available:" $7}\'',
      swapInfo: 'free -h | grep Swap | awk \'{print "total:" $2, "used:" $3, "free:" $4}\'',
      uptime: 'uptime -p',
      cpuTemp: 'sensors 2>/dev/null | grep "Core 0" | awk \'{print $3}\' | head -1 || echo "N/A"',
      gpuTemp: 'nvidia-smi --query-gpu=temperature.gpu,name --format=csv,noheader 2>/dev/null || echo ""',
      gpuPower: 'nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null || echo ""',
      diskUsage: 'df -h / | tail -1 | awk \'{print $5}\'',
      waterTemp: 'bizon-cooling-status temp 2>/dev/null || echo "N/A"',
    };

    const results = await ssh.execMultiple(conn, commands);
    const r = (key) => results[key]?.output || 'N/A';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          cpu: { usage: r('cpuUsage'), temperature: r('cpuTemp'), loadAverage: r('loadAvg') },
          memory: r('memInfo'),
          swap: r('swapInfo'),
          gpu: { temperatures: r('gpuTemp'), powerDraw: r('gpuPower') },
          disk: { rootUsage: r('diskUsage') },
          cooling: { waterTemperature: r('waterTemp') },
          uptime: r('uptime'),
          timestamp: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: run_command ──────────────────────────────────────────────────────

server.tool(
  'run_command',
  'Execute a shell command on the workstation via SSH. Returns stdout, stderr, and exit code. Use this for any custom commands not covered by other tools.',
  {
    ...credentialsSchema,
    command: z.string().describe('The shell command to execute'),
  },
  async ({ username, password, command }) => {
    const conn = await ssh.getConnection(username, password);
    const result = await ssh.exec(conn, command);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          command,
          output: result.output,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: run_sudo_command ─────────────────────────────────────────────────

server.tool(
  'run_sudo_command',
  'Execute a shell command with sudo privileges. Required for system-level operations like installing packages, modifying system configs, etc.',
  {
    ...sudoSchema,
    command: z.string().describe('The shell command to execute with sudo'),
  },
  async ({ username, password, sudoPassword, command }) => {
    const conn = await ssh.getConnection(username, password);
    const result = await ssh.execSudo(conn, command, sudoPassword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          command: `sudo ${command}`,
          output: result.output,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: set_gpu_power_limit ──────────────────────────────────────────────

server.tool(
  'set_gpu_power_limit',
  'Set the GPU power limit (TDP) in watts. Requires sudo. Use get_gpu_status first to see current limits and valid ranges.',
  {
    ...sudoSchema,
    watts: z.number().describe('Power limit in watts'),
    gpuIndex: z.number().optional().describe('GPU index (0-based). If omitted, applies to all GPUs.'),
  },
  async ({ username, password, sudoPassword, watts, gpuIndex }) => {
    const conn = await ssh.getConnection(username, password);
    const gpuFlag = gpuIndex !== undefined ? `-i ${gpuIndex}` : '';
    const command = `nvidia-smi ${gpuFlag} -pl ${watts}`;
    const result = await ssh.execSudo(conn, command, sudoPassword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.exitCode === 0,
          command: `sudo ${command}`,
          watts,
          gpuIndex: gpuIndex ?? 'all',
          output: result.output,
          stderr: result.stderr,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: set_fan_speed ────────────────────────────────────────────────────

server.tool(
  'set_fan_speed',
  'Set GPU fan speed percentage (0-100). Requires sudo. This enables manual fan control mode.',
  {
    ...sudoSchema,
    speed: z.number().min(0).max(100).describe('Fan speed percentage (0-100)'),
    gpuIndex: z.number().optional().describe('GPU index (0-based). Defaults to 0.'),
  },
  async ({ username, password, sudoPassword, speed, gpuIndex }) => {
    const conn = await ssh.getConnection(username, password);
    const idx = gpuIndex ?? 0;
    const command = `nvidia-settings -a "[gpu:${idx}]/GPUFanControlState=1" && nvidia-settings -a "[fan:${idx}]/GPUTargetFanSpeed=${speed}"`;
    const result = await ssh.execSudo(conn, command, sudoPassword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.exitCode === 0,
          speed,
          gpuIndex: idx,
          output: result.output,
          stderr: result.stderr,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: reboot_machine ───────────────────────────────────────────────────

server.tool(
  'reboot_machine',
  'Reboot the workstation. Requires sudo password. The machine will be unavailable during restart.',
  sudoSchema,
  async ({ username, password, sudoPassword }) => {
    const conn = await ssh.getConnection(username, password);
    const result = await ssh.execSudo(conn, 'reboot', sudoPassword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.exitCode === 0,
          message: result.exitCode === 0 ? 'Reboot command sent. Machine will restart.' : 'Reboot failed.',
          output: result.output,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: shutdown_machine ─────────────────────────────────────────────────

server.tool(
  'shutdown_machine',
  'Shut down the workstation. Requires sudo password. The machine will need to be physically turned back on.',
  sudoSchema,
  async ({ username, password, sudoPassword }) => {
    const conn = await ssh.getConnection(username, password);
    const result = await ssh.execSudo(conn, 'shutdown -h now', sudoPassword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.exitCode === 0,
          message: result.exitCode === 0 ? 'Shutdown command sent.' : 'Shutdown failed.',
          output: result.output,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_processes ────────────────────────────────────────────────────

server.tool(
  'get_processes',
  'Get running processes sorted by CPU or memory usage. Useful for finding resource-heavy workloads.',
  {
    ...credentialsSchema,
    sortBy: z.enum(['cpu', 'memory']).optional().describe('Sort by cpu or memory usage. Default: cpu'),
    limit: z.number().optional().describe('Max number of processes to return. Default: 20'),
  },
  async ({ username, password, sortBy = 'cpu', limit = 20 }) => {
    const conn = await ssh.getConnection(username, password);
    const sortFlag = sortBy === 'memory' ? '--sort=-%mem' : '--sort=-%cpu';
    const result = await ssh.exec(conn, `ps aux ${sortFlag} | head -n ${limit + 1}`);

    return {
      content: [{
        type: 'text',
        text: result.output,
      }],
    };
  }
);

// ─── Tool: get_gpu_processes ────────────────────────────────────────────────

server.tool(
  'get_gpu_processes',
  'Get processes currently using the GPUs, including PID, process name, and GPU memory usage',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);
    const result = await ssh.exec(conn,
      'nvidia-smi --query-compute-apps=pid,name,gpu_uuid,used_memory --format=csv,noheader 2>/dev/null || echo "No GPU processes"'
    );

    return {
      content: [{
        type: 'text',
        text: result.output || 'No GPU processes running',
      }],
    };
  }
);

// ─── Tool: get_disk_usage ───────────────────────────────────────────────────

server.tool(
  'get_disk_usage',
  'Get disk usage information including all mounted filesystems and block devices',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);
    const commands = {
      df: 'df -h | grep -v tmpfs | grep -v udev',
      lsblk: 'lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE',
    };
    const results = await ssh.execMultiple(conn, commands);

    return {
      content: [{
        type: 'text',
        text: `=== Disk Usage ===\n${results.df.output}\n\n=== Block Devices ===\n${results.lsblk.output}`,
      }],
    };
  }
);

// ─── Tool: get_network_info ─────────────────────────────────────────────────

server.tool(
  'get_network_info',
  'Get network configuration including IP addresses, interfaces, active connections, and DNS settings',
  credentialsSchema,
  async ({ username, password }) => {
    const conn = await ssh.getConnection(username, password);
    const commands = {
      ip: 'ip addr show',
      routes: 'ip route show default',
      dns: 'cat /etc/resolv.conf | grep nameserver',
      connections: 'ss -tunp | head -20',
    };
    const results = await ssh.execMultiple(conn, commands);

    return {
      content: [{
        type: 'text',
        text: `=== IP Addresses ===\n${results.ip.output}\n\n=== Default Route ===\n${results.routes.output}\n\n=== DNS ===\n${results.dns.output}\n\n=== Active Connections (top 20) ===\n${results.connections.output}`,
      }],
    };
  }
);

// ─── Tool: manage_service ───────────────────────────────────────────────────

server.tool(
  'manage_service',
  'Manage a systemd service (start, stop, restart, status, enable, disable). Requires sudo for start/stop/restart/enable/disable.',
  {
    ...sudoSchema,
    service: z.string().describe('Name of the systemd service (e.g., "docker", "nginx")'),
    action: z.enum(['start', 'stop', 'restart', 'status', 'enable', 'disable']).describe('Action to perform'),
  },
  async ({ username, password, sudoPassword, service, action }) => {
    const conn = await ssh.getConnection(username, password);

    let result;
    if (action === 'status') {
      result = await ssh.exec(conn, `systemctl status ${service} 2>&1 || true`);
    } else {
      result = await ssh.execSudo(conn, `systemctl ${action} ${service}`, sudoPassword);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          service,
          action,
          success: result.exitCode === 0,
          output: result.output,
          stderr: result.stderr,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: install_package ──────────────────────────────────────────────────

server.tool(
  'install_package',
  'Install a package using apt (Ubuntu/Debian). Requires sudo.',
  {
    ...sudoSchema,
    package: z.string().describe('Package name to install (e.g., "htop", "nvidia-cuda-toolkit")'),
  },
  async ({ username, password, sudoPassword, package: pkg }) => {
    const conn = await ssh.getConnection(username, password);
    const result = await ssh.execSudo(conn, `apt-get install -y ${pkg}`, sudoPassword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          package: pkg,
          success: result.exitCode === 0,
          output: result.output.slice(-2000), // Trim long output
          stderr: result.stderr.slice(-500),
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: read_file ────────────────────────────────────────────────────────

server.tool(
  'read_file',
  'Read the contents of a file on the workstation',
  {
    ...credentialsSchema,
    path: z.string().describe('Absolute file path to read'),
    lines: z.number().optional().describe('Max number of lines to read. Default: all'),
  },
  async ({ username, password, path, lines }) => {
    const conn = await ssh.getConnection(username, password);
    const cmd = lines ? `head -n ${lines} "${path}"` : `cat "${path}"`;
    const result = await ssh.exec(conn, cmd);

    if (result.exitCode !== 0) {
      return {
        content: [{ type: 'text', text: `Error reading file: ${result.stderr || result.output}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: result.output }],
    };
  }
);

// ─── Tool: write_file ───────────────────────────────────────────────────────

server.tool(
  'write_file',
  'Write content to a file on the workstation. Use with caution.',
  {
    ...credentialsSchema,
    path: z.string().describe('Absolute file path to write'),
    content: z.string().describe('Content to write to the file'),
    append: z.boolean().optional().describe('If true, append instead of overwrite. Default: false'),
  },
  async ({ username, password, path, content: fileContent, append }) => {
    const conn = await ssh.getConnection(username, password);
    const operator = append ? '>>' : '>';
    // Use heredoc to safely write multi-line content
    const cmd = `cat ${operator} "${path}" << 'BIZON_EOF'\n${fileContent}\nBIZON_EOF`;
    const result = await ssh.exec(conn, cmd);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.exitCode === 0,
          path,
          action: append ? 'appended' : 'written',
          stderr: result.stderr,
        }, null, 2),
      }],
    };
  }
);

// ─── Start the server ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const transportArg = args.find((a, i) => args[i - 1] === '--transport') || 'stdio';
  const portArg = parseInt(args.find((a, i) => args[i - 1] === '--port') || '4001');

  if (transportArg === 'sse') {
    // SSE transport — runs as an HTTP server for remote AI integrations
    const app = express();

    // Store transports by session
    const transports = {};

    app.get('/sse', async (req, res) => {
      const transport = new SSEServerTransport('/messages', res);
      transports[transport.sessionId] = transport;
      
      res.on('close', () => {
        delete transports[transport.sessionId];
      });

      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId;
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).json({ error: 'Unknown session' });
      }
    });

    app.listen(portArg, '0.0.0.0', () => {
      console.log(`Bizon MCP Server (SSE) running on port ${portArg}`);
      console.log(`Connect at: http://localhost:${portArg}/sse`);
    });
  } else {
    // stdio transport — for local AI tool integrations (e.g., Claude Desktop, Cursor)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Bizon MCP Server running on stdio');
  }
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
