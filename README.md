# Bizon-Tech SSH API Server

This Node.js server provides a secure API to interact with Bizon-Tech workstations and servers via SSH.

## Features

- SSH connection verification
- Remote command execution
- System information retrieval
- Secure communication between app and machine

## Installation

### Standard Installation

1. Install dependencies:
   ```
   npm install
   ```

2. Start the server:
   ```
   npm start
   ```

### System Service Installation (Recommended for Production)

This method is recommended for production use, especially when the API needs to access GPU information and system hardware.

1. Make the installation script executable:
   ```
   chmod +x install_services.sh
   ```

2. Run the installation script:
   ```
   ./install_services.sh
   ```

3. The script will:
   - Install all required dependencies
   - Configure and install systemd service files
   - Start both the API server and camera server
   - Enable the services to start automatically on boot

4. To check service status:
   ```
   sudo systemctl status bizon-api.service
   sudo systemctl status bizon-camera.service
   ```

5. To view logs:
   ```
   sudo journalctl -u bizon-api.service -f
   sudo journalctl -u bizon-camera.service -f
   ```

6. To uninstall the services:
   ```
   ./uninstall_services.sh
   ```

### Docker Installation

1. Make sure Docker and Docker Compose are installed on your system.

2. Deploy using the provided script:
   ```
   ./deploy.sh
   ```

   Or manually with Docker Compose:
   ```
   docker-compose up -d
   ```

3. The servers will be available at:
   - API Server: http://localhost:4000
   - Camera Server: http://localhost:8000

4. To view logs:
   ```
   docker-compose logs -f
   ```

5. To stop the servers:
   ```
   docker-compose down
   ```

## API Endpoints

- `/api/ssh-uname` - Verify SSH connection by running uname -a
- `/api/run-command` - Execute a command on the machine
- `/api/system-info` - Get detailed system information

## Security

This API server should only be accessible on your local network. It does not implement authentication beyond the SSH credentials themselves.

## For Bizon-Tech Support

This server is part of the Bizon-Tech mobile app ecosystem, allowing customers to control and monitor their AI workstations and servers.
