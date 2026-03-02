const express = require('express');
const cors = require('cors');
const { requestLogger, errorHandler } = require('./lib/middleware');

// Import route modules
const systemRoutes = require('./routes/system');
const commandRoutes = require('./routes/commands');
const gpuRoutes = require('./routes/gpu');
const monitoringRoutes = require('./routes/monitoring');
const cameraRoutes = require('./routes/camera');
const diagnosticRoutes = require('./routes/diagnostic');

const app = express();

// Global middleware
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Health check
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Bizon API server is running',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// API version info
app.get('/api/version', (req, res) => {
  res.json({
    api: '2.0.0',
    features: [
      'system-info', 'detailed-specs', 'run-command', 'run-sudo-command',
      'gpu-status', 'gpu-processes', 'set-gpu-power-limit', 'set-fan-speed',
      'processes', 'disk-usage', 'network-stats', 'system-health',
      'reboot', 'shutdown', 'camera-stream', 'camera-feed',
      'diagnostic-chat',
    ],
    mcp: true,
  });
});

// Mount route modules
app.use('/api', systemRoutes);
app.use('/api', commandRoutes);
app.use('/api', gpuRoutes);
app.use('/api', monitoringRoutes);
app.use('/api', cameraRoutes);
app.use('/api/diagnostic', diagnosticRoutes);

// Error handling middleware (must be last)
app.use(errorHandler);

// Graceful shutdown
const sshManager = require('./lib/ssh-manager');
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  sshManager.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  sshManager.destroy();
  process.exit(0);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bizon API server v2.0.0 running on port ${PORT}`);
  console.log(`Endpoints: http://localhost:${PORT}/ping`);
});
