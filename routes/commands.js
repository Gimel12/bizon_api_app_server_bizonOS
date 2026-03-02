const express = require('express');
const router = express.Router();
const ssh = require('../lib/ssh-manager');
const { requireCredentials, requireCommand, asyncHandler } = require('../lib/middleware');

/**
 * POST /api/run-command
 * Execute an arbitrary command on the machine via SSH.
 */
router.post('/run-command', requireCredentials, requireCommand, asyncHandler(async (req, res) => {
  const { username, password, command } = req.body;
  const conn = await ssh.getConnection(username, password);
  const result = await ssh.exec(conn, command);

  res.json({
    output: result.output,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}));

/**
 * POST /api/run-sudo-command
 * Execute a command with sudo privileges.
 */
router.post('/run-sudo-command', requireCredentials, requireCommand, asyncHandler(async (req, res) => {
  const { username, password, command, sudoPassword } = req.body;

  if (!sudoPassword) {
    return res.status(400).json({ error: 'Missing sudoPassword field' });
  }

  const conn = await ssh.getConnection(username, password);
  const result = await ssh.execSudo(conn, command, sudoPassword);

  res.json({
    output: result.output,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}));

module.exports = router;
