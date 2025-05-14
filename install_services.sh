#!/bin/bash

# Bizon-Tech API Server Installation Script
echo "Installing Bizon-Tech API Server as system services..."

# Set up Git repository first
if [ -f "./setup_git_repo.sh" ]; then
    echo "Setting up Git repository..."
    ./setup_git_repo.sh
fi

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
npm install

# Install Python dependencies
echo "Installing Python dependencies..."
pip3 install -r camera_requirements.txt

# No need to update user in service files as we're running as system user
echo "Service files are configured to run as system user"

# Make the camera server script executable
chmod +x camera_server.py
chmod +x static_camera_server.py

# Install the services
echo "Installing systemd services..."
sudo cp bizon-api.service /etc/systemd/system/
sudo cp bizon-camera.service /etc/systemd/system/
sudo cp bizon-static-camera.service /etc/systemd/system/
sudo systemctl daemon-reload

# Enable and start the services
echo "Enabling and starting services..."
sudo systemctl enable bizon-api.service
sudo systemctl start bizon-api.service
sudo systemctl enable bizon-camera.service
sudo systemctl start bizon-camera.service
sudo systemctl enable bizon-static-camera.service
sudo systemctl start bizon-static-camera.service

# Check service status
echo "Checking service status..."
echo "API Server status:"
sudo systemctl status bizon-api.service --no-pager
echo ""
echo "Camera Server status:"
sudo systemctl status bizon-camera.service --no-pager
echo ""
echo "Static Camera Server status:"
sudo systemctl status bizon-static-camera.service --no-pager

echo ""
echo "Installation complete!"
echo "API server is available at: http://localhost:4000"
echo "Camera server is available at: http://localhost:8000"
echo "Static camera server is available at: http://localhost:8000"
echo ""
echo "To check service status:"
echo "  sudo systemctl status bizon-api.service"
echo "  sudo systemctl status bizon-camera.service"
echo "  sudo systemctl status bizon-static-camera.service"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u bizon-api.service -f"
echo "  sudo journalctl -u bizon-camera.service -f"
echo "  sudo journalctl -u bizon-static-camera.service -f"
echo ""
echo "To restart services:"
echo "  sudo systemctl restart bizon-api.service"
echo "  sudo systemctl restart bizon-camera.service"
echo "  sudo systemctl restart bizon-static-camera.service"
