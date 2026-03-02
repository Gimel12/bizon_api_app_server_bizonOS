/**
 * Middleware for request validation and error handling.
 */

/**
 * Validates that username and password are present in the request body.
 */
function requireCredentials(req, res, next) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({
      error: 'Missing required credentials',
      details: 'Both username and password are required',
    });
  }
  next();
}

/**
 * Validates that a command is present in the request body.
 */
function requireCommand(req, res, next) {
  const { command } = req.body;
  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({
      error: 'Missing required field',
      details: 'A non-empty command string is required',
    });
  }
  next();
}

/**
 * Global async error handler wrapper.
 * Wraps an async route handler so thrown errors are caught and forwarded.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handling middleware. Must be registered last.
 */
function errorHandler(err, req, res, _next) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  if (err.message && err.message.includes('SSH connection timeout')) {
    return res.status(504).json({ error: 'SSH connection timeout', details: err.message });
  }

  if (err.message && (err.message.includes('Authentication failed') || err.message.includes('All configured'))) {
    return res.status(401).json({ error: 'Authentication failed', details: 'Invalid username or password' });
  }

  if (err.message && err.message.includes('ECONNREFUSED')) {
    return res.status(502).json({ error: 'Connection refused', details: 'SSH server is not reachable' });
  }

  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
  });
}

/**
 * Request logging middleware.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
}

module.exports = {
  requireCredentials,
  requireCommand,
  asyncHandler,
  errorHandler,
  requestLogger,
};
