const { exec } = require('child_process');

/**
 * The local (non-SSH) user whose login environment commands should run in.
 * The API server runs as root under systemd, so we must switch to the real
 * user to get conda, CUDA, user PATH entries, etc.
 */
const LOCAL_USER = process.env.BIZON_LOCAL_USER || 'bizon';

/**
 * Execute a command locally using child_process.exec.
 * Returns { output, stderr, exitCode } — same shape as ssh-manager.exec.
 *
 * Commands are wrapped with `sudo -u <user> -i bash -c '...'` so they
 * inherit the target user's full login shell environment (conda base,
 * CUDA toolkit, user PATH, etc.) rather than root's minimal systemd env.
 *
 * If the original command already contains `sudo`, it is executed directly
 * (the server already runs as root).
 */
function localExec(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    // Build the actual command to execute
    let shellCmd;
    if (command.trim().startsWith('sudo ')) {
      // Already privileged — run directly (we're root)
      shellCmd = command;
    } else {
      // Run as the local user with a full login shell
      const escaped = command.replace(/'/g, "'\\''");
      shellCmd = `sudo -u ${LOCAL_USER} -i bash -c '${escaped}'`;
    }

    exec(shellCmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timeout);
      if (err && err.killed) {
        return reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }
      // Resolve even on non-zero exit — the AI needs to see the output
      resolve({
        output: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: err ? err.code || 1 : 0,
      });
    });
  });
}

module.exports = { localExec };
