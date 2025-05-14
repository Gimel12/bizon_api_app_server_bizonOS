#!/bin/bash

# Bizon-Tech API Server Git Repository Setup Script
echo "Setting up Git repository for Bizon-Tech API Server..."

# Store current directory
SETUP_DIR="/opt/bizon-api-server"
cd $SETUP_DIR

# GitHub repository URL
REPO_URL="https://github.com/Gimel12/bizon_api_app_server_bizonOS.git" # Replace with your actual GitHub repo URL

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "Git is not installed. Installing git..."
    sudo apt-get update
    sudo apt-get install -y git
fi

# Initialize git repository if not already initialized
if [ ! -d ".git" ]; then
    echo "Initializing git repository..."
    git init
    git remote add origin $REPO_URL
    
    # Configure git to not track permission changes
    git config core.fileMode false
    
    # Set default branch to match remote (main or master)
    git fetch
    MAIN_BRANCH=$(git ls-remote --symref origin HEAD | grep -o 'refs/heads/[^ ]*' | sed 's|refs/heads/||')
    if [ -z "$MAIN_BRANCH" ]; then
        MAIN_BRANCH="main"
    fi
    git checkout -b $MAIN_BRANCH
    
    echo "Git repository initialized with remote: $REPO_URL"
    echo "Default branch set to: $MAIN_BRANCH"
else
    echo "Git repository already initialized."
    # Update remote URL in case it changed
    git remote set-url origin $REPO_URL
    echo "Remote URL updated to: $REPO_URL"
fi

echo "Setup complete!"
echo "You can now use the update scripts to pull the latest changes."
