FROM node:18-slim

# Install Python and required packages
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-opencv \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Setup Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy Python requirements and install
COPY camera_requirements.txt ./
RUN pip3 install --no-cache-dir -r camera_requirements.txt

# Copy all files
COPY . .

# Make Python scripts executable
RUN chmod +x camera_server.py
RUN chmod +x static_camera_server.py

# Expose ports for both servers
EXPOSE 4000 8000

# Create startup script
RUN echo '#!/bin/bash\n\
node index.js & \n\
python3 camera_server.py & \n\
wait' > /app/start.sh && chmod +x /app/start.sh

# Start both servers
CMD ["/app/start.sh"]
