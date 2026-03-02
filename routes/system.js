const express = require('express');
const router = express.Router();
const ssh = require('../lib/ssh-manager');
const { requireCredentials, asyncHandler } = require('../lib/middleware');

/**
 * POST /api/ssh-uname
 * Verify SSH connection and get basic system info.
 */
router.post('/ssh-uname', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    uname: 'uname -a',
    hostname: 'hostname',
    cpu: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
    memory: 'free -h | grep "Mem:" | awk \'{print $2}\'',
    kernel: 'uname -r',
    gpus: 'nvidia-smi --query-gpu=name --format=csv,noheader | wc -l',
    gpuModel: 'nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1',
    bizonos: 'cat /etc/bizonos-version 2>/dev/null || bizonos 2>/dev/null || echo "Unknown"',
  };

  const results = await ssh.execMultiple(conn, commands);

  // Format GPU info
  let gpuInfo = 'No GPUs detected';
  try {
    const gpuCount = parseInt(results.gpus.output);
    if (gpuCount > 0 && results.gpuModel.output) {
      gpuInfo = `${gpuCount}x ${results.gpuModel.output}`;
    }
  } catch {}

  // Format kernel version
  let kernelVersion = 'Unknown';
  const kernelMatch = results.kernel.output.match(/^(\d+\.\d+)/);
  if (kernelMatch) kernelVersion = kernelMatch[1];

  // Parse BizonOS version
  const bizonosRaw = results.bizonos.output;
  const bizonosMatch = bizonosRaw.match(/([\d.]+)/);
  const bizonosVersion = bizonosMatch ? bizonosMatch[1] : bizonosRaw || 'Unknown';

  res.json({
    uname: results.uname.output,
    systemInfo: {
      hostname: results.hostname.output,
      cpu: results.cpu.output,
      memory: results.memory.output,
      kernel: kernelVersion,
      gpus: gpuInfo,
      bizonos: bizonosVersion,
    },
  });
}));

/**
 * POST /api/system-info
 * Get system summary information.
 */
router.post('/system-info', asyncHandler(async (req, res) => {
  if (!req.body.username || !req.body.password) {
    return res.json({
      uname: 'Not connected',
      systemInfo: {
        hostname: 'Not connected',
        cpu: 'Not connected',
        memory: 'Not connected',
        kernel: 'Not connected',
        gpus: [],
        bizonos: 'Not connected',
      },
    });
  }

  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    uname: 'uname -a',
    hostname: 'hostname',
    cpu: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
    memory: 'free -h | grep Mem | awk \'{print $2}\'',
    gpu: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo ""',
    bizonos: 'cat /etc/bizonos-version 2>/dev/null || bizonos 2>/dev/null || echo "Unknown"',
  };

  const results = await ssh.execMultiple(conn, commands);

  // Parse kernel version
  let kernelVersion = 'Unknown';
  if (results.uname.output) {
    const match = results.uname.output.match(/Linux\s+\S+\s+([\d.]+\S*)/i);
    kernelVersion = match ? match[1] : 'Unknown';
  }

  // Parse GPU information
  let gpuInfo = [];
  if (results.gpu.output) {
    gpuInfo = results.gpu.output
      .split('\n')
      .filter(line => line.trim() && !line.includes('name'))
      .map(line => ({ name: line.trim() }));
  }

  // Format memory
  let formattedMemory = results.memory.output || 'Unknown';
  const memMatch = formattedMemory.match(/(\d+)/);
  if (memMatch) formattedMemory = `${memMatch[1]}GB`;

  // Format CPU
  const formattedCPU = results.cpu.output || 'Unknown';

  // Parse BizonOS version
  const bizonosRaw = results.bizonos.output;
  const bizonosMatch = bizonosRaw.match(/([\d.]+)/);
  const bizonosVersion = bizonosMatch ? bizonosMatch[1] : bizonosRaw || 'Unknown';

  res.json({
    uname: results.uname.output,
    systemInfo: {
      hostname: results.hostname.output,
      cpu: formattedCPU,
      memory: formattedMemory,
      kernel: kernelVersion,
      gpus: gpuInfo,
      bizonos: bizonosVersion,
    },
  });
}));

/**
 * POST /api/detailed-specs
 * Get comprehensive hardware specifications.
 */
router.post('/detailed-specs', requireCredentials, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const conn = await ssh.getConnection(username, password);

  const commands = {
    // System
    hostname: 'hostname',
    kernel: 'uname -r',
    os: 'lsb_release -ds 2>/dev/null || cat /etc/*release | grep "PRETTY_NAME" | sed \'s/PRETTY_NAME=//\' | tr -d \'"\' || cat /etc/issue | head -n 1',
    bizonos: 'cat /etc/bizonos-version 2>/dev/null || bizonos 2>/dev/null || echo "Unknown"',
    uptime: 'uptime -p',

    // CPU
    cpu_model: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
    cpu_cores: 'nproc',
    cpu_threads: 'lscpu | grep "^CPU(s):" | awk \'{print $2}\'',
    cpu_architecture: 'lscpu | grep "Architecture" | awk \'{print $2}\'',
    cpu_max_freq: 'lscpu | grep "CPU max MHz" | awk \'{print $4}\'',
    cpu_cache: 'lscpu | grep "L3 cache" | sed "s/L3 cache://g" | xargs',

    // Memory
    memory_total: 'free -h | grep "Mem:" | awk \'{print $2}\'',
    memory_type: 'sudo dmidecode -t memory 2>/dev/null | grep -m 1 "Type:" | awk \'{print $2}\' || echo "Unknown"',
    memory_speed: 'sudo dmidecode -t memory 2>/dev/null | grep -m 1 "Speed:" | awk \'{print $2, $3}\' || echo "Unknown"',
    memory_slots: 'sudo dmidecode -t memory 2>/dev/null | grep -c "Memory Device" || echo "Unknown"',
    memory_used_slots: 'sudo dmidecode -t memory 2>/dev/null | grep -c "Size: [0-9]" || echo "Unknown"',

    // GPU
    gpu_count: 'nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null | head -1 || echo "0"',
    gpu_models: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "None"',
    gpu_vram: 'nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo "Unknown"',
    gpu_driver: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 || echo "Unknown"',
    gpu_temp: 'nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null || echo "Unknown"',
    gpu_power: 'nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null || echo "Unknown"',
    gpu_utilization: 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader 2>/dev/null || echo "Unknown"',
    gpu_memory_used: 'nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo "Unknown"',
    gpu_power_limit: 'nvidia-smi --query-gpu=power.limit --format=csv,noheader 2>/dev/null || echo "Unknown"',

    // Storage
    storage_devices: 'lsblk -d -o NAME,SIZE,MODEL | grep -v "loop" | grep -v "NAME" || echo "Unknown"',
    root_partition: 'df -h / | grep -v "Filesystem" | awk \'{print $2, "total,", $3, "used,", $4, "free"}\'',
    nvme_count: 'lsblk | grep -c "nvme" || echo "0"',
    ssd_count: 'lsblk | grep -c "sda\\|sdb\\|sdc\\|sdd" || echo "0"',

    // Network
    network_interfaces: 'ip -o link show | grep -v "lo:" | awk -F": " \'{print $2}\'',
    primary_ip: 'hostname -I | awk \'{print $1}\'',
    network_speed: 'ethtool $(ip -o -4 route show to default | awk \'{print $5}\') 2>/dev/null | grep "Speed:" | awk \'{print $2}\' || echo "Unknown"',

    // Power
    power_supply: 'sudo dmidecode -t 39 2>/dev/null | grep "Max Power Capacity" | awk \'{print $4, $5}\' || echo "Unknown"',

    // Cooling
    cooling_fans: 'sensors 2>/dev/null | grep -c "fan" || echo "Unknown"',
    cpu_temp: 'sensors 2>/dev/null | grep "Core 0" | awk \'{print $3}\' | head -n 1 || echo "Unknown"',

    // Physical
    chassis_type: 'sudo dmidecode -t chassis 2>/dev/null | grep "Type:" | awk \'{print $2, $3, $4, $5}\' || echo "Unknown"',
    chassis_manufacturer: 'sudo dmidecode -t chassis 2>/dev/null | grep "Manufacturer:" | sed "s/.*Manufacturer://g" | xargs || echo "Unknown"',

    // Watercooling (custom Bizon commands)
    water_temp: 'bizon-cooling-status temp 2>/dev/null || echo "Unknown"',
    water_flow: 'bizon-cooling-status flow 2>/dev/null || echo "Unknown"',
    pump_rpm: 'bizon-cooling-status pump 2>/dev/null || echo "Unknown"',
  };

  const results = await ssh.execMultiple(conn, commands);
  const r = (key) => results[key]?.output || 'Unknown';

  // Process GPU information
  let gpus = [];
  try {
    const gpuCount = parseInt(r('gpu_count'));
    const gpuModels = r('gpu_models').split('\n');
    const gpuVram = r('gpu_vram').split('\n');
    const gpuTemps = r('gpu_temp').split('\n');
    const gpuPower = r('gpu_power').split('\n');
    const gpuUtil = r('gpu_utilization').split('\n');
    const gpuMemUsed = r('gpu_memory_used').split('\n');
    const gpuPowerLimit = r('gpu_power_limit').split('\n');

    for (let i = 0; i < gpuCount; i++) {
      gpus.push({
        name: gpuModels[i]?.trim() || 'Unknown GPU',
        vram: gpuVram[i]?.trim() || 'Unknown',
        temperature: gpuTemps[i]?.trim() || 'Unknown',
        powerDraw: gpuPower[i]?.trim() || 'Unknown',
        powerLimit: gpuPowerLimit[i]?.trim() || 'Unknown',
        utilization: gpuUtil[i]?.trim() || 'Unknown',
        memoryUsed: gpuMemUsed[i]?.trim() || 'Unknown',
        index: i,
      });
    }
  } catch (e) {
    console.error('Error processing GPU info:', e);
  }

  // Process storage
  let storage = [];
  try {
    const storageLines = r('storage_devices').split('\n');
    storageLines.forEach(line => {
      if (line.trim()) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          storage.push({
            device: parts[0],
            size: parts[1],
            model: parts.slice(2).join(' '),
          });
        }
      }
    });
  } catch {}

  // Process network
  let network = [];
  try {
    const interfaces = r('network_interfaces').split('\n');
    interfaces.forEach(iface => {
      if (iface.trim()) {
        network.push({ interface: iface.trim(), speed: r('network_speed') });
      }
    });
  } catch {}

  // BizonOS version
  const bizonosRaw = r('bizonos');
  const bizonosMatch = bizonosRaw.match(/([\d.]+)/);
  const bizonosVersion = bizonosMatch ? bizonosMatch[1] : bizonosRaw;

  const detailedSpecs = {
    system: {
      hostname: r('hostname'),
      kernel: r('kernel'),
      os: r('os'),
      bizonos: bizonosVersion,
      uptime: r('uptime'),
      ip: r('primary_ip'),
    },
    processor: {
      model: r('cpu_model'),
      cores: r('cpu_cores'),
      threads: r('cpu_threads'),
      architecture: r('cpu_architecture'),
      maxFrequency: r('cpu_max_freq') !== 'Unknown' ? `${Math.round(parseFloat(r('cpu_max_freq')) / 1000)} GHz` : 'Unknown',
      cache: r('cpu_cache'),
      temperature: r('cpu_temp'),
    },
    memory: {
      total: r('memory_total'),
      type: r('memory_type'),
      speed: r('memory_speed'),
      slots: {
        total: r('memory_slots'),
        used: r('memory_used_slots'),
      },
    },
    graphics: {
      count: r('gpu_count'),
      gpus,
      driver: r('gpu_driver'),
    },
    storage: {
      devices: storage,
      rootPartition: r('root_partition'),
      nvmeCount: r('nvme_count'),
      ssdCount: r('ssd_count'),
    },
    network: {
      interfaces: network,
      primaryIp: r('primary_ip'),
    },
    power: {
      supply: r('power_supply'),
    },
    cooling: {
      fans: r('cooling_fans'),
      waterCooling: {
        temperature: r('water_temp'),
        flowRate: r('water_flow'),
        pumpSpeed: r('pump_rpm'),
      },
    },
    physical: {
      chassisType: r('chassis_type'),
      manufacturer: r('chassis_manufacturer'),
    },
  };

  res.json({ detailedSpecs });
}));

module.exports = router;
