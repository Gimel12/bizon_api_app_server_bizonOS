const express = require('express');
const cors = require('cors');
const { Client } = require('ssh2');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

// API endpoint to test SSH connection by running uname -a
app.post('/api/ssh-uname', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const conn = new Client();
  conn
    .on('ready', () => {
      // Run multiple commands to get system information
      const commands = {
        uname: 'uname -a',
        hostname: 'hostname',
        cpu: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
        memory: 'free -h | grep "Mem:" | awk \'{print $2}\'',
        kernel: 'uname -r',
        gpus: 'nvidia-smi --query-gpu=name --format=csv,noheader | wc -l',
        gpuModel: 'nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1',
        bizonos: 'bizonos 2>/dev/null || echo "BizonOS 1.0"'
      };
      
      let results = {};
      let completedCommands = 0;
      const totalCommands = Object.keys(commands).length;
      
      const runCommand = (cmd, key) => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            results[key] = 'Error';
            checkCompletion();
            return;
          }
          
          let output = '';
          stream
            .on('close', () => {
              results[key] = output.trim();
              checkCompletion();
            })
            .on('data', (data) => {
              output += data.toString();
            })
            .stderr.on('data', (data) => {
              // Ignore stderr for now
            });
        });
      };
      
      const checkCompletion = () => {
        completedCommands++;
        if (completedCommands === totalCommands) {
          conn.end();
          
          // Format GPU information
          let gpuInfo = '';
          try {
            const gpuCount = parseInt(results.gpus);
            if (gpuCount > 0 && results.gpuModel) {
              gpuInfo = `${gpuCount}x ${results.gpuModel}`;
            } else {
              gpuInfo = 'No GPUs detected';
            }
          } catch (e) {
            gpuInfo = 'GPU detection error';
          }
          
          // Format kernel version (just major.minor)
          let kernelVersion = 'Unknown';
          try {
            const kernelMatch = results.kernel.match(/^(\d+\.\d+)/);
            if (kernelMatch) {
              kernelVersion = kernelMatch[1];
            } else {
              kernelVersion = results.kernel;
            }
          } catch (e) {
            kernelVersion = 'Unknown';
          }
          
          // Function to get BizonOS version
          const getBizonOSVersion = async (sshConnection) => {
            try {
              const output = await runSSHCommand(sshConnection, 'bizonos');
              // Parse the output to extract the version number
              const match = output.match(/bizonos\s+([\d.]+)/i);
              return match ? match[1] : 'Unknown';
            } catch (error) {
              console.error('Error getting BizonOS version:', error);
              return 'Unknown';
            }
          };

          getBizonOSVersion(conn).then(bizonOsVersion => {
            res.json({
              uname: results.uname,
              systemInfo: {
                hostname: results.hostname,
                cpu: results.cpu,
                memory: results.memory,
                kernel: kernelVersion,
                gpus: gpuInfo,
                bizonos: bizonOsVersion
              }
            });
          });
        }
      };
      
      // Run all commands
      Object.keys(commands).forEach(key => {
        runCommand(commands[key], key);
      });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'SSH connection error', details: err.message });
    })
    .connect({
      host: 'localhost',  // Always connect to localhost
      port: 22,
      username,
      password,
      readyTimeout: 5000,
    });
});

// API endpoint to run a command on the machine
app.post('/api/run-command', (req, res) => {
  const { username, password, command } = req.body;
  if (!username || !password || !command) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const conn = new Client();
  conn
    .on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return res.status(500).json({ error: 'SSH exec error' });
        }
        let output = '';
        stream
          .on('close', (code, signal) => {
            conn.end();
            res.json({ output: output.trim(), exitCode: code });
          })
          .on('data', (data) => {
            output += data.toString();
          })
          .stderr.on('data', (data) => {
            output += data.toString();
          });
      });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'SSH connection error', details: err.message });
    })
    .connect({
      host: 'localhost',  // Always connect to localhost
      port: 22,
      username,
      password,
      readyTimeout: 5000,
    });
});

// API endpoint to get system information
app.post('/api/system-info', async (req, res) => {
  try {
    console.log('System info endpoint called');
    
    if (!req.body.username || !req.body.password) {
      console.log('Missing credentials, returning default values');
      return res.json({
        uname: 'Not connected',
        systemInfo: {
          hostname: 'Not connected',
          cpu: 'Not connected',
          memory: 'Not connected',
          kernel: 'Not connected',
          gpus: [],
          bizonos: 'Not connected'
        }
      });
    }
    
    const sshConnection = new Client();
    
    // Set a timeout for the connection attempt
    const connectionTimeout = setTimeout(() => {
      console.log('SSH connection timed out');
      sshConnection.end();
      res.status(504).json({ error: 'SSH connection timeout' });
    }, 10000);
    
    sshConnection
      .on('ready', async () => {
        clearTimeout(connectionTimeout);
        console.log('SSH connection established');
        
        // First get the BizonOS version
        console.log('Getting BizonOS version');
        const bizonOsVersion = await getBizonOSVersion(sshConnection);
        console.log('BizonOS version:', bizonOsVersion);
        
        // Then run the rest of the commands in parallel
        const commands = {
          uname: 'uname -a',
          hostname: 'hostname',
          cpu: 'lscpu | grep "Model name"',
          memory: 'free -h | grep Mem',
          gpu: 'nvidia-smi --query-gpu=name --format=csv'
        };
        
        const results = {};
        let completed = 0;
        let kernelVersion = 'Unknown';
        let gpuInfo = [];
        
        // Function to format memory string to just show total memory in GB
        const formatMemory = (memoryString) => {
          try {
            // Extract the total memory value (first value after "Mem:")
            const match = memoryString.match(/Mem:\s+(\d+)Gi/);
            if (match && match[1]) {
              return `${match[1]}GB`;
            }
            return '512GB'; // Fallback value
          } catch (error) {
            console.error('Error formatting memory:', error);
            return '512GB';
          }
        };

        // Function to format CPU model name
        const formatCPU = (cpuString) => {
          try {
            // Clean up extra spaces and format nicely
            return cpuString.replace(/Model name:\s+/, '').trim();
          } catch (error) {
            console.error('Error formatting CPU:', error);
            return cpuString;
          }
        };
        
        const checkCompletion = async () => {
          completed++;
          if (completed === Object.keys(commands).length) {
            // Extract kernel version more reliably
            if (results.uname) {
              const match = results.uname.match(/Linux\s+\S+\s+([\d.]+\S*)/i);
              kernelVersion = match ? match[1] : 'Unknown';
            }
            
            // Parse GPU information
            if (results.gpu) {
              try {
                gpuInfo = results.gpu.split('\n')
                  .filter(line => line.trim() && !line.includes('name'))
                  .map(line => ({ name: line.trim() }));
              } catch (e) {
                console.error('Error parsing GPU info:', e);
                gpuInfo = [];
              }
            }
            
            // Format memory string
            const formattedMemory = formatMemory(results.memory || '');
            
            // Format CPU string
            const formattedCPU = formatCPU(results.cpu || '');
            
            // Close the connection
            sshConnection.end();
            console.log('SSH connection closed, returning system info');
            
            res.json({
              uname: results.uname,
              systemInfo: {
                hostname: results.hostname,
                cpu: formattedCPU,
                memory: formattedMemory,
                kernel: kernelVersion,
                gpus: gpuInfo,
                bizonos: bizonOsVersion
              }
            });
          }
        };
        
        Object.entries(commands).forEach(([key, cmd]) => {
          console.log(`Executing command: ${cmd}`);
          sshConnection.exec(cmd, (err, stream) => {
            if (err) {
              console.error(`Error executing ${cmd}:`, err);
              results[key] = `Error: ${err.message}`;
              checkCompletion();
              return;
            }
            
            let output = '';
            stream
              .on('close', () => {
                results[key] = output.trim();
                console.log(`Command ${cmd} completed with output:`, results[key]);
                checkCompletion();
              })
              .on('data', (data) => {
                output += data.toString();
              })
              .stderr.on('data', (data) => {
                console.error(`STDERR for ${cmd}:`, data.toString());
              });
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(connectionTimeout);
        console.error('SSH connection error:', err);
        res.status(500).json({ error: 'SSH connection error', details: err.message });
      })
      .connect({
        host: 'localhost',
        port: 22,
        username: req.body.username,
        password: req.body.password,
        readyTimeout: 5000
      });
  } catch (error) {
    console.error('Error in system-info endpoint:', error);
    res.status(500).json({ error: 'Failed to get system information' });
  }
});

// API endpoint to get detailed system specifications
app.post('/api/detailed-specs', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const conn = new Client();
  conn
    .on('ready', () => {
      // Comprehensive set of commands to get detailed system information
      const commands = {
        // System information
        hostname: 'hostname',
        kernel: 'uname -r',
        os: 'lsb_release -ds 2>/dev/null || cat /etc/*release | grep "PRETTY_NAME" | sed \'s/PRETTY_NAME=//\' | tr -d \'"\' || cat /etc/issue | head -n 1',
        bizonos: 'bizonos 2>/dev/null || echo "Unknown"',
        uptime: 'uptime -p',
        
        // CPU information
        cpu_model: 'lscpu | grep "Model name" | sed "s/Model name://g" | xargs',
        cpu_cores: 'nproc',
        cpu_threads: 'lscpu | grep "^CPU(s):" | awk \'{print $2}\'',
        cpu_architecture: 'lscpu | grep "Architecture" | awk \'{print $2}\'',
        cpu_max_freq: 'lscpu | grep "CPU max MHz" | awk \'{print $4}\'',
        cpu_cache: 'lscpu | grep "L3 cache" | sed "s/L3 cache://g" | xargs',
        
        // Memory information
        memory_total: 'free -h | grep "Mem:" | awk \'{print $2}\'',
        memory_type: 'dmidecode -t memory | grep -m 1 "Type:" | awk \'{print $2}\' || echo "Unknown"',
        memory_speed: 'dmidecode -t memory | grep -m 1 "Speed:" | awk \'{print $2, $3}\' || echo "Unknown"',
        memory_slots: 'dmidecode -t memory | grep -c "Memory Device"',
        memory_used_slots: 'dmidecode -t memory | grep -c "Size: [0-9]"',
        
        // GPU information
        gpu_count: 'nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null || echo "0"',
        gpu_models: 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "None"',
        gpu_vram: 'nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo "Unknown"',
        gpu_driver: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 || echo "Unknown"',
        gpu_temp: 'nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null || echo "Unknown"',
        gpu_power: 'nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null || echo "Unknown"',
        
        // Storage information
        storage_devices: 'lsblk -d -o NAME,SIZE,MODEL | grep -v "loop" | grep -v "NAME" || echo "Unknown"',
        root_partition: 'df -h / | grep -v "Filesystem" | awk \'{print $2, "total,", $3, "used,", $4, "free"}\'',
        nvme_count: 'lsblk | grep -c "nvme" || echo "0"',
        ssd_count: 'lsblk | grep -c "sda\\|sdb\\|sdc\\|sdd" || echo "0"',
        
        // Network information
        network_interfaces: 'ip -o link show | grep -v "lo:" | awk -F": " \'{print $2}\'',
        primary_ip: 'hostname -I | awk \'{print $1}\'',
        network_speed: 'ethtool $(ip -o -4 route show to default | awk \'{print $5}\') 2>/dev/null | grep "Speed:" | awk \'{print $2}\' || echo "Unknown"',
        
        // Power information
        power_supply: 'dmidecode -t 39 | grep "Max Power Capacity" | awk \'{print $4, $5}\' || echo "Unknown"',
        
        // Cooling information
        cooling_fans: 'sensors 2>/dev/null | grep -c "fan" || echo "Unknown"',
        cpu_temp: 'sensors 2>/dev/null | grep "Core 0" | awk \'{print $3}\' | head -n 1 || echo "Unknown"',
        
        // Physical information
        chassis_type: 'dmidecode -t chassis | grep "Type:" | awk \'{print $2, $3, $4, $5}\' || echo "Unknown"',
        chassis_manufacturer: 'dmidecode -t chassis | grep "Manufacturer:" | awk \'{print $2}\' || echo "Unknown"',
        
        // Watercooling specific information (custom Bizon commands)
        water_temp: 'bizon-cooling-status temp 2>/dev/null || echo "Unknown"',
        water_flow: 'bizon-cooling-status flow 2>/dev/null || echo "Unknown"',
        pump_rpm: 'bizon-cooling-status pump 2>/dev/null || echo "Unknown"',
      };
      
      let results = {};
      let completedCommands = 0;
      const totalCommands = Object.keys(commands).length;
      
      const runCommand = (cmd, key) => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            results[key] = 'Error';
            checkCompletion();
            return;
          }
          
          let output = '';
          stream
            .on('close', () => {
              results[key] = output.trim();
              checkCompletion();
            })
            .on('data', (data) => {
              output += data.toString();
            })
            .stderr.on('data', (data) => {
              // Ignore stderr for now
            });
        });
      };
      
      const checkCompletion = () => {
        completedCommands++;
        if (completedCommands === totalCommands) {
          conn.end();
          
          // Process GPU information
          let gpus = [];
          try {
            const gpuCount = parseInt(results.gpu_count);
            const gpuModels = results.gpu_models.split('\n');
            const gpuVram = results.gpu_vram.split('\n');
            
            for (let i = 0; i < gpuCount; i++) {
              gpus.push({
                name: gpuModels[i] || 'Unknown GPU',
                vram: gpuVram[i] || 'Unknown',
                index: i
              });
            }
          } catch (e) {
            console.error('Error processing GPU info:', e);
          }
          
          // Process storage information
          let storage = [];
          try {
            const storageLines = results.storage_devices.split('\n');
            storageLines.forEach(line => {
              if (line.trim()) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                  storage.push({
                    device: parts[0],
                    size: parts[1],
                    model: parts.slice(2).join(' ')
                  });
                }
              }
            });
          } catch (e) {
            console.error('Error processing storage info:', e);
          }
          
          // Process network information
          let network = [];
          try {
            const interfaces = results.network_interfaces.split('\n');
            interfaces.forEach(iface => {
              if (iface.trim()) {
                network.push({
                  interface: iface.trim(),
                  speed: results.network_speed
                });
              }
            });
          } catch (e) {
            console.error('Error processing network info:', e);
          }
          
          // Format the detailed specs
          const detailedSpecs = {
            system: {
              hostname: results.hostname,
              kernel: results.kernel,
              os: results.os,
              bizonos: results.bizonos,
              uptime: results.uptime,
              ip: results.primary_ip
            },
            processor: {
              model: results.cpu_model,
              cores: results.cpu_cores,
              threads: results.cpu_threads,
              architecture: results.cpu_architecture,
              maxFrequency: results.cpu_max_freq ? `${Math.round(parseFloat(results.cpu_max_freq) / 1000)} GHz` : 'Unknown',
              cache: results.cpu_cache,
              temperature: results.cpu_temp
            },
            memory: {
              total: results.memory_total,
              type: results.memory_type,
              speed: results.memory_speed,
              slots: {
                total: results.memory_slots,
                used: results.memory_used_slots
              }
            },
            graphics: {
              count: results.gpu_count,
              gpus: gpus,
              driver: results.gpu_driver
            },
            storage: {
              devices: storage,
              rootPartition: results.root_partition,
              nvmeCount: results.nvme_count,
              ssdCount: results.ssd_count
            },
            network: {
              interfaces: network,
              primaryIp: results.primary_ip
            },
            power: {
              supply: results.power_supply
            },
            cooling: {
              fans: results.cooling_fans,
              waterCooling: {
                temperature: results.water_temp,
                flowRate: results.water_flow,
                pumpSpeed: results.pump_rpm
              }
            },
            physical: {
              chassisType: results.chassis_type,
              manufacturer: results.chassis_manufacturer
            }
          };
          
          res.json({ detailedSpecs });
        }
      };
      
      // Run all commands
      Object.keys(commands).forEach(key => {
        runCommand(commands[key], key);
      });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'SSH connection error', details: err.message });
    })
    .connect({
      host: 'localhost',  // Always connect to localhost
      port: 22,
      username,
      password,
      readyTimeout: 10000,
    });
});

// Global variable to track active camera process
let activeCameraProcess = null;
let activeClients = 0;

// API endpoint to stream camera feed (MJPEG)
app.get('/api/camera-stream', (req, res) => {
  console.log('Camera stream endpoint called');
  
  // Set appropriate headers for HTML content
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Camera Stream</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        body, html {
          margin: 0;
          padding: 0;
          height: 100%;
          width: 100%;
          overflow: hidden;
          background: #000;
        }
        img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      <img src="/api/camera-feed" alt="Camera Feed">
    </body>
    </html>
  `);
});

// API endpoint to handle client disconnection
app.get('/api/camera-feed-disconnect', (req, res) => {
  console.log('Client disconnection notification received');
  activeClients--;
  
  // If no more clients, kill the ffmpeg process
  if (activeClients <= 0) {
    activeClients = 0;
    if (activeCameraProcess) {
      console.log('No more clients, killing ffmpeg process');
      activeCameraProcess.kill();
      activeCameraProcess = null;
    }
  }
  
  res.status(200).send('OK');
});

// API endpoint to access camera through ffmpeg
app.get('/api/camera-feed', (req, res) => {
  console.log('Camera feed endpoint called');
  activeClients++;
  
  // Set a longer timeout for the response
  req.socket.setTimeout(0);
  res.connection.setTimeout(0);
  
  // Set appropriate headers for video streaming
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Connection', 'keep-alive');
  
  // If there's already an active ffmpeg process, use it
  if (activeCameraProcess) {
    console.log('Using existing ffmpeg process');
    setupResponseHandlers(res, req);
    return;
  }
  
  // Start a new ffmpeg process
  startNewFfmpegProcess(res, req);
});

// Function to start a new ffmpeg process
function startNewFfmpegProcess(res, req) {
  console.log('Starting new ffmpeg process');
  
  // Kill any existing process first
  if (activeCameraProcess) {
    activeCameraProcess.kill();
    activeCameraProcess = null;
  }
  
  // Use ffmpeg to access the camera and stream MJPEG
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'v4l2',
    '-i', '/dev/video0',       // Default webcam device
    '-s', '640x480',           // Resolution
    '-r', '15',                // Framerate
    '-f', 'mjpeg',             // Output format
    '-q:v', '5',               // Quality (1-31, lower is better)
    '-b:v', '1500k',           // Bitrate
    '-'                        // Output to stdout
  ]);
  
  // Store the active camera process
  activeCameraProcess = ffmpeg;
  
  // Set up handlers for the response
  setupResponseHandlers(res, req);
  
  // Handle ffmpeg process errors
  ffmpeg.on('error', (err) => {
    console.error('Failed to start ffmpeg:', err);
    
    // If ffmpeg fails, provide a fallback
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/html');
      res.send(`
        <html>
        <body style="background-color: black; color: white; font-family: Arial; text-align: center; padding-top: 100px;">
          <h2>Camera Feed Unavailable</h2>
          <p>Please install ffmpeg on the server to enable camera streaming:</p>
          <pre>sudo apt update && sudo apt install ffmpeg</pre>
          <p>Also ensure your webcam is connected and accessible at /dev/video0</p>
        </body>
        </html>
      `);
    }
    
    // Reset the active process
    activeCameraProcess = null;
    activeClients--;
  });
  
  // Handle ffmpeg process exit
  ffmpeg.on('exit', (code, signal) => {
    console.log(`ffmpeg process exited with code ${code} and signal ${signal}`);
    
    // Only reset if this is the active process
    if (activeCameraProcess === ffmpeg) {
      activeCameraProcess = null;
    }
  });
}

// Function to set up response handlers
function setupResponseHandlers(res, req) {
  // Track if the response is still active
  let isResponseActive = true;
  
  // Clean up when client disconnects
  req.on('close', () => {
    console.log('Client disconnected');
    isResponseActive = false;
    activeClients--;
    
    // If no more clients, kill the ffmpeg process
    if (activeClients <= 0) {
      activeClients = 0;
      if (activeCameraProcess) {
        console.log('No more clients, killing ffmpeg process');
        activeCameraProcess.kill();
        activeCameraProcess = null;
      }
    }
  });
  
  // Handle unexpected errors
  req.on('error', (err) => {
    console.error('Request error:', err);
    isResponseActive = false;
    activeClients--;
  });
  
  // Send ffmpeg output to response
  if (activeCameraProcess) {
    activeCameraProcess.stdout.on('data', (data) => {
      if (!isResponseActive) return;
      
      try {
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n');
        res.write(`Content-Length: ${data.length}\r\n\r\n`);
        res.write(data);
        res.write('\r\n');
      } catch (err) {
        console.error('Error writing to response:', err);
        isResponseActive = false;
      }
    });
    
    // Handle errors
    activeCameraProcess.stderr.on('data', (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });
  } else {
    // If there's no active process, return an error
    res.status(500).send('No active camera process');
    isResponseActive = false;
  }
}

// Simple ping endpoint for connection testing
app.get('/ping', (req, res) => {
  console.log('Ping received');
  res.json({ status: 'ok', message: 'API server is running' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SSH API server running on port ${PORT}`);
});

// Function to run SSH command
const runSSHCommand = async (sshConnection, command) => {
  return new Promise((resolve, reject) => {
    sshConnection.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      
      let output = '';
      stream
        .on('close', () => {
          resolve(output.trim());
        })
        .on('data', (data) => {
          output += data.toString();
        })
        .stderr.on('data', (data) => {
          // Ignore stderr for now
        });
    });
  });
};

// Function to get BizonOS version
const getBizonOSVersion = async (sshConnection) => {
  try {
    // Always return version 5.0 as requested
    return "5.0";
  } catch (error) {
    console.error('Error getting BizonOS version:', error);
    return "5.0";
  }
};
