# Bizon-Tech API Server Suite

This package provides a complete API solution for Bizon-Tech workstations and servers, including:

1. **Node.js API Server**: Secure API for SSH interactions
2. **Camera Server**: Python-based camera streaming service
3. **Static Camera Server**: Lightweight camera image capture service

## Features

- SSH connection verification and remote command execution
- System information retrieval and hardware monitoring
- Live camera streaming and image capture
- Automatic updates from GitHub repository
- Systemd service integration for reliability

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

## API Endpoints

### API Server (Port 4000)

- `GET /api/ssh-uname` - Verify SSH connection by running uname -a
- `POST /api/run-command` - Execute a command on the machine
- `GET /api/system-info` - Get detailed system information

### Camera Server (Port 8000)

- `GET /` - Camera server status information
- `GET /api/camera-frame` - Get a base64 encoded camera frame
- `GET /api/camera-jpeg` - Get a JPEG image from the camera
- `GET /api/camera-status` - Get camera status information

## Security

This API server suite should only be accessible on your local network. It does not implement authentication beyond the SSH credentials themselves.

## Directory Structure

After installation, all files are stored in `/opt/bizon-api-server/` with the following structure:

- `index.js` - Main API server code
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
