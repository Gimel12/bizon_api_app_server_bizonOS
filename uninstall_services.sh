#!/bin/bash

# Bizon-Tech API Server Uninstallation Script
echo "Uninstalling Bizon-Tech API Server services..."

# Stop and disable services
echo "Stopping and disabling services..."
sudo systemctl stop bizon-api.service
sudo systemctl disable bizon-api.service
sudo systemctl stop bizon-camera.service
sudo systemctl disable bizon-camera.service
sudo systemctl stop bizon-static-camera.service
sudo systemctl disable bizon-static-camera.service

# Remove service files
echo "Removing service files..."
sudo rm -f /etc/systemd/system/bizon-api.service
sudo rm -f /etc/systemd/system/bizon-camera.service
sudo rm -f /etc/systemd/system/bizon-static-camera.service
sudo systemctl daemon-reload

echo "Uninstallation complete!"
echo "The Bizon-Tech API Server services have been removed from the system."
echo "The code files remain in this directory."
