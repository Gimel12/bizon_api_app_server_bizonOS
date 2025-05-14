#!/bin/bash

# Bizon-Tech API Server Automatic Update Script
# This script runs automatically via systemd timer

# Store current directory
UPDATE_DIR="/opt/bizon-api-server"
cd $UPDATE_DIR

# Log file for update results
LOG_FILE="/var/log/bizon-update.log"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

echo "[$TIMESTAMP] Starting automatic update check..." >> $LOG_FILE

# GitHub repository URL
REPO_URL="https://github.com/Gimel12/bizon_api_app_server_bizonOS.git" # Replace with your actual GitHub repo URL

# Check if git repository is properly set up
if [ ! -d ".git" ]; then
    echo "[$TIMESTAMP] Setting up git repository..." >> $LOG_FILE
    git init
    git remote add origin $REPO_URL
fi

# Check for updates
echo "[$TIMESTAMP] Checking for updates..." >> $LOG_FILE
git fetch origin

# Get the hash of the current commit
CURRENT_HASH=$(git rev-parse HEAD)
# Get the hash of the remote commit
REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/master)

# If the hashes are different, there are updates available
if [ "$CURRENT_HASH" != "$REMOTE_HASH" ]; then
    echo "[$TIMESTAMP] Updates found. Updating..." >> $LOG_FILE
    
    # Pull latest changes
    git reset --hard origin/main 2>/dev/null || git reset --hard origin/master
    
    # Install dependencies
    npm install >> $LOG_FILE 2>&1
    
    # Make scripts executable
    chmod +x *.py
    chmod +x *.sh
    
    # Restart services
    echo "[$TIMESTAMP] Restarting services..." >> $LOG_FILE
    systemctl restart bizon-api.service
    systemctl restart bizon-camera.service
    systemctl restart bizon-static-camera.service
    
    echo "[$TIMESTAMP] Update completed successfully." >> $LOG_FILE
else
    echo "[$TIMESTAMP] No updates available." >> $LOG_FILE
fi

exit 0
