#!/bin/bash

# Bizon-Tech API Server Update Script
echo "Updating Bizon-Tech API Server..."

# Store current directory
UPDATE_DIR="/opt/bizon-api-server"
cd $UPDATE_DIR

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "Git is not installed. Installing git..."
    sudo apt-get update
    sudo apt-get install -y git
fi

# GitHub repository URL
REPO_URL="https://github.com/Gimel12/bizon_api_app_server_bizonOS.git" # Replace with your actual GitHub repo URL

# Check if the directory is a git repository
if [ ! -d ".git" ]; then
    echo "This is not a git repository. Setting up git..."
    # Initialize git and add remote
    git init
    git remote add origin $REPO_URL
fi

# Pull latest changes
echo "Pulling latest changes from repository..."
git fetch --all
git reset --hard origin/main || git reset --hard origin/master

# Install dependencies
echo "Installing Node.js dependencies..."
npm install

# Make scripts executable
chmod +x *.py
chmod +x *.sh

# Restart services
echo "Restarting services..."
sudo systemctl restart bizon-api.service
sudo systemctl restart bizon-camera.service
sudo systemctl restart bizon-static-camera.service

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
echo "Update complete!"
echo "API server is available at: http://localhost:4000"
echo "Camera servers are available at: http://localhost:8000"
