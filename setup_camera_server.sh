#!/bin/bash

# Bizon-Tech Camera Server Setup Script
echo "Setting up Bizon-Tech Camera Server..."

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is not installed. Installing..."
    sudo apt update
    sudo apt install -y python3 python3-pip
fi

# Install required packages
echo "Installing required Python packages..."
pip3 install -r camera_requirements.txt

# Make the camera server script executable
chmod +x camera_server.py

# Create a systemd service file for auto-start
echo "Creating systemd service for camera server..."
SERVICE_FILE="bizon-camera.service"
CURRENT_USER=$(whoami)
CURRENT_DIR=$(pwd)
PYTHON_PATH=$(which python3)

cat > $SERVICE_FILE << EOF
[Unit]
Description=Bizon-Tech Camera Server
After=network.target

[Service]
User=$CURRENT_USER
WorkingDirectory=$CURRENT_DIR
ExecStart=$PYTHON_PATH $CURRENT_DIR/camera_server.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bizon-camera

[Install]
WantedBy=multi-user.target
EOF

# Install the service
sudo mv $SERVICE_FILE /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable bizon-camera.service
sudo systemctl start bizon-camera.service

echo "Bizon-Tech Camera Server has been installed and started!"
echo "Camera stream is available at: http://localhost:8000/api/camera-stream"
echo "Camera status is available at: http://localhost:8000/api/camera-status"
echo "To check service status: sudo systemctl status bizon-camera.service"
