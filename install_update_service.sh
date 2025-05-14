#!/bin/bash

# Bizon-Tech API Server Update Service Installation Script
echo "Installing Bizon-Tech API Server update service..."

# Copy service and timer files
sudo cp bizon-update.service /etc/systemd/system/
sudo cp bizon-update.timer /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start the timer
sudo systemctl enable bizon-update.timer
sudo systemctl start bizon-update.timer

# Check status
echo "Update timer status:"
sudo systemctl status bizon-update.timer --no-pager

echo ""
echo "Installation complete!"
echo "The system will check for updates daily."
echo ""
echo "To manually update at any time, run:"
echo "  sudo /opt/bizon-api-server/update_services.sh"
echo ""
echo "To check update timer status:"
echo "  sudo systemctl status bizon-update.timer"
echo ""
echo "To view update logs:"
echo "  sudo cat /var/log/bizon-update.log"
