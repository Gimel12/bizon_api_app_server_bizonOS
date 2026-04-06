const { exec } = require('child_process');

/**
 * Execute a command locally using child_process.exec.
 * Returns { output, stderr, exitCode } — same shape as ssh-manager.exec.
 */
function localExec(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
