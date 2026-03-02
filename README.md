# Bizon-Tech API Server Suite v2.1

## Overview

The Bizon-Tech API Server Suite provides a complete solution for remote monitoring, management, and **AI-powered diagnostics** of Bizon workstations. It consists of four main components:

1. **Node.js REST API Server** (Port 4000) - Main API for system information, SSH commands, GPU management, and workstation control
2. **BizonAI Diagnostic Agent** (via REST API) - Claude-powered AI that runs commands on the machine to diagnose and fix hardware issues
3. **MCP Server** (stdio or SSE on Port 4001) - Model Context Protocol server enabling AI models to control workstations
4. **Python Camera Server** (Port 8000) - Handles webcam streaming and image capture

## Features

- SSH connection verification and remote command execution
- System information retrieval and hardware monitoring
- **Real-time GPU monitoring** (temperature, utilization, power, memory, clocks)
- **GPU power limit (TDP) control** via `nvidia-smi`
- **Fan speed control** via `nvidia-settings` or IPMI
- **Process management** (system and GPU processes)
- **Disk usage and network statistics**
- **System health dashboard** (CPU, memory, swap, temps, load)
- **BizonAI Diagnostic Agent** — AI-powered hardware diagnostics with tool calling, rate limiting, and prompt caching
- **MCP Server** for AI model integration (Claude, Cursor, etc.)
- Live camera streaming and image capture
- Automatic updates from GitHub repository
- Systemd service integration for reliability

## Architecture (v2.1)

```
bizon_api_app_server_bizonOS/
├── index.js              # Express REST API entry point (port 4000)
├── mcp-server.js         # MCP server entry point (stdio or SSE port 4001)
├── package.json
├── mcp-config.json       # MCP client configuration template
├── knowledge-base.json   # Bizon diagnostic knowledge base for AI agent
├── rate-limits.json      # Auto-generated: per-user daily rate limits
├── lib/
│   ├── ssh-manager.js    # SSH connection pooling & command execution
│   └── middleware.js      # Request validation, logging, error handling
├── routes/
│   ├── system.js         # /api/ssh-uname, /api/system-info, /api/detailed-specs
│   ├── commands.js       # /api/run-command, /api/run-sudo-command
│   ├── gpu.js            # /api/gpu-status, /api/gpu-processes, /api/set-gpu-power-limit, /api/set-fan-speed
│   ├── monitoring.js     # /api/processes, /api/disk-usage, /api/network-stats, /api/system-health, /api/reboot, /api/shutdown
│   ├── camera.js         # /api/camera-stream, /api/camera-feed
│   └── diagnostic.js     # /api/diagnostic/chat, /api/diagnostic/quick-actions, /api/diagnostic/rate-limit
```

## MCP Server

The MCP (Model Context Protocol) server allows AI models like Claude to directly control and monitor Bizon workstations.

### Quick Start

**stdio transport** (for Claude Desktop, Cursor, Windsurf):
```bash
npm run mcp
```

**SSE transport** (for remote/network AI integrations):
```bash
npm run mcp:sse
```

**Run both REST API + MCP SSE together:**
```bash
npm run start:all
```

### Claude Desktop / Cursor Configuration

Add this to your MCP client config (e.g. `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "bizon-workstation": {
      "command": "node",
      "args": ["mcp-server.js", "--transport", "stdio"],
      "cwd": "/opt/bizon-api-server"
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_system_info` | Basic system info (hostname, CPU, memory, GPUs, kernel, BizonOS) |
| `get_detailed_specs` | Full hardware specifications |
| `get_gpu_status` | Real-time GPU metrics (temp, util, power, memory, clocks, fan) |
| `get_system_health` | Overall system health (CPU, memory, swap, GPU temps, disk, cooling) |
| `run_command` | Execute shell commands via SSH |
| `run_sudo_command` | Execute privileged commands with sudo |
| `set_gpu_power_limit` | Set GPU TDP in watts (requires sudo) |
| `set_fan_speed` | Set fan speed 0-100% (requires sudo) |
| `reboot_machine` | Reboot the workstation (requires sudo) |
| `shutdown_machine` | Shut down the workstation (requires sudo) |
| `get_processes` | List running processes sorted by CPU or memory |
| `get_gpu_processes` | List GPU-accelerated processes |
| `get_disk_usage` | Disk usage and block device info |
| `get_network_info` | Network interfaces, routes, DNS, connections |
| `manage_service` | Start/stop/restart/status systemd services |
| `install_package` | Install apt packages (requires sudo) |
| `read_file` | Read file contents from the workstation |
| `write_file` | Write/append to files on the workstation |

## REST API Endpoints

### Health & Info
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ping` | Health check |
| GET | `/api/version` | API version and feature list |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/ssh-uname` | Verify SSH connection + basic info |
| POST | `/api/system-info` | System summary |
| POST | `/api/detailed-specs` | Full hardware specifications |
| POST | `/api/system-health` | Real-time health metrics |

### Commands
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/run-command` | Execute shell command |
| POST | `/api/run-sudo-command` | Execute with sudo |

### GPU
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/gpu-status` | Real-time GPU metrics |
| POST | `/api/gpu-processes` | GPU process list |
| POST | `/api/set-gpu-power-limit` | Set GPU TDP (watts) |
| POST | `/api/set-fan-speed` | Set fan speed (0-100%) |

### Monitoring
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/processes` | System process list |
| POST | `/api/disk-usage` | Disk usage info |
| POST | `/api/network-stats` | Network statistics |
| POST | `/api/reboot` | Reboot machine |
| POST | `/api/shutdown` | Shutdown machine |

### Camera
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/camera-stream` | HTML MJPEG viewer |
| GET | `/api/camera-feed` | Raw MJPEG stream |

### BizonAI Diagnostic Agent
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/diagnostic/chat` | AI-powered diagnostic chat (Claude + tool calling) |
| GET | `/api/diagnostic/quick-actions` | Get preset diagnostic quick actions |
| GET | `/api/diagnostic/rate-limit/:userId` | Check remaining daily requests |

## BizonAI Diagnostic Agent

The diagnostic agent uses Claude (Anthropic) with tool calling to run commands on the workstation, analyze output, and diagnose hardware issues — all from the mobile app.

### How It Works

1. User sends a message (e.g., "Check my GPUs for errors")
2. The API server sends the message to Claude with a `run_ssh_command` tool
3. Claude decides which commands to run (e.g., `nvidia-smi`, `dmesg | grep xid`)
4. The server executes each command via SSH and feeds results back to Claude
5. Claude analyzes the output and returns a diagnostic summary
6. The full response with usage stats is sent to the mobile app

### Key Features

- **Tool Calling Loop** — Claude autonomously runs up to 10 command iterations per request
- **Rate Limiting** — 5 requests/day per user (tracked in `rate-limits.json`)
- **Prompt Caching** — System prompt + knowledge base cached via Anthropic's `cache_control`, saving ~90% input tokens on repeat requests
- **Knowledge Base** — `knowledge-base.json` contains Bizon-specific diagnostic commands, GPU fan curve workflows, TDP change procedures, and troubleshooting guides
- **Sudo Support** — Optional sudo password for privileged commands (IPMI, smartctl, ras-mc-ctl)
- **90s Hard Timeout** — Prevents requests from hanging indefinitely
- **Quick Actions** — 6 preset diagnostic prompts: Health Check, GPU Diagnostics, Memory Errors, Storage Health, Temperatures, Error Scan

### Environment Setup

**Required:** Set the `ANTHROPIC_API_KEY` environment variable on the workstation:

```bash
# Add to /etc/environment or the systemd service file
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

For the systemd service:
```bash
sudo systemctl edit bizon-api.service
# Add under [Service]:
# Environment=ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
sudo systemctl restart bizon-api.service
```

### Request Format

```json
POST /api/diagnostic/chat
{
  "username": "bizon",
  "password": "...",
  "messages": [
    { "role": "user", "content": "Check my GPUs for errors" }
  ],
  "userId": "firebase_uid",
  "sudoPassword": "optional_sudo_pass"
}
```

### Response Format

```json
{
  "content": "## GPU Diagnostic Report\n...",
  "usage": {
    "inputTokens": 1500,
    "outputTokens": 800,
    "totalTokens": 2300,
    "cacheReadTokens": 1200,
    "toolCalls": 3,
    "iterations": 2
  },
  "toolCalls": [
    { "command": "nvidia-smi --query-gpu=...", "duration": 1200 },
    { "command": "dmesg | grep xid", "duration": 800 }
  ],
  "rateLimit": {
    "remaining": 4,
    "total": 5,
    "resetsAt": "2026-03-03T00:00:00.000Z"
  }
}
```

## Installation

### Production Installation (Recommended)

This method installs the API servers as system services for maximum reliability and security.

1. Clone this repository to a temporary location:
   ```bash
   git clone https://github.com/Gimel12/bizon_api_app_server_bizonOS.git
   cd bizon_api_app_server_bizonOS
   ```

2. Run the installation script with sudo:
   ```bash
   sudo ./install_services.sh
   ```

3. The script will:
   - Install all required dependencies
   - Configure and install systemd service files
   - Install the API server, camera server, and static camera server
   - Enable automatic updates from GitHub
   - Start all services and configure them to run at boot

4. After installation, the original directory can be safely deleted as all files are copied to `/opt/bizon-api-server`

### Checking Status and Logs

1. Check service status:
   ```bash
   sudo systemctl status bizon-api.service
   sudo systemctl status bizon-camera.service
   sudo systemctl status bizon-static-camera.service
   ```

2. View logs:
   ```bash
   sudo journalctl -u bizon-api.service -f
   sudo journalctl -u bizon-camera.service -f
   sudo journalctl -u bizon-static-camera.service -f
   ```

3. To uninstall the services:
   ```bash
   sudo /opt/bizon-api-server/uninstall_services.sh
   ```

### Development Installation

For development purposes only:

1. Install dependencies:
   ```bash
   npm install
   pip3 install -r camera_requirements.txt
   ```

2. Start the servers manually:
   ```bash
   # API Server
   node index.js
   
   # Camera Server
   python3 camera_server.py
   
   # Static Camera Server
   python3 static_camera_server.py
   ```

### Docker Installation

1. Make sure Docker and Docker Compose are installed on your system.

2. Deploy using the provided script:
   ```bash
   ./deploy.sh
   ```

   Or manually with Docker Compose:
   ```bash
   docker-compose up -d
   ```

3. The servers will be available at:
   - API Server: http://localhost:4000
   - Camera Server: http://localhost:8000

4. To view logs:
   ```bash
   docker-compose logs -f
   ```

5. To stop the servers:
   ```bash
   docker-compose down
   ```

## Update System

The API server suite includes a robust update system that automatically pulls changes from GitHub.

### Automatic Updates

By default, the system checks for updates daily and applies them automatically. No manual intervention required.

### Manual Updates

1. Using the command line alias (recommended):
   ```bash
   bizonapp-update
   ```

2. Or directly with the update script:
   ```bash
   sudo /opt/bizon-api-server/update_services.sh
   ```

### Update Logs

Update logs are stored in `/var/log/bizon-update.log`

## Additional Servers

### Camera Server (Port 8000)

- `GET /` - Camera server status information
- `GET /api/camera-frame` - Get a base64 encoded camera frame
- `GET /api/camera-jpeg` - Get a JPEG image from the camera
- `GET /api/camera-status` - Get camera status information

## Security

This API server suite should only be accessible on your local network. It does not implement authentication beyond the SSH credentials themselves.

## Directory Structure

After installation, all files are stored in `/opt/bizon-api-server/` with the following structure:

- `index.js` - Main API server entry point
- `mcp-server.js` - MCP server entry point
- `knowledge-base.json` - Bizon diagnostic knowledge base
- `lib/` - SSH manager and middleware
- `routes/` - Modular route handlers (system, commands, gpu, monitoring, camera, diagnostic)
- `camera_server.py` - Camera streaming server
- `static_camera_server.py` - Static camera server
- `*.service` - Systemd service files
- `update_services.sh` - Manual update script
- `auto_update.sh` - Automatic update script (run by systemd timer)

## For Bizon-Tech Support

This server suite is part of the Bizon-Tech mobile app ecosystem, allowing customers to control and monitor their AI workstations and servers. The system is designed for reliability with automatic restarts and updates.

### Common Support Tasks

- Check service status: `sudo systemctl status bizon-api.service`
- Restart services: `sudo systemctl restart bizon-api.service`
- View logs: `sudo journalctl -u bizon-api.service -f`
- Force update: `bizonapp-update`
