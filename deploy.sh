#!/bin/bash

# Bizon-Tech API Server Deployment Script
echo "Deploying Bizon-Tech API Server..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed. Please install Docker first."
    echo "Visit https://docs.docker.com/get-docker/ for installation instructions."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "Docker Compose is not installed. Please install Docker Compose first."
    echo "Visit https://docs.docker.com/compose/install/ for installation instructions."
    exit 1
fi

# Build and start the Docker container
echo "Building and starting Docker container..."
docker-compose up -d --build

# Check if the container is running
if [ $? -eq 0 ]; then
    echo "Bizon-Tech API Server has been successfully deployed!"
    echo "API server is available at: http://localhost:4000"
    echo "Camera server is available at: http://localhost:8000"
    echo ""
    echo "To check logs: docker-compose logs -f"
    echo "To stop the server: docker-compose down"
else
    echo "Failed to deploy Bizon-Tech API Server. Check the logs for details."
fi
