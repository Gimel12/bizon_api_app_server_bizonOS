const { Client } = require('ssh2');

/**
 * SSHManager - Manages SSH connections with pooling and reuse.
 * Eliminates duplicated SSH logic across endpoints.
 */
class SSHManager {
  constructor() {
    // Connection pool: key = `${username}@localhost`, value = { conn, lastUsed, busy }
    this.pool = new Map();
    this.POOL_TIMEOUT_MS = 60000; // Close idle connections after 60s
    this.READY_TIMEOUT_MS = 10000;

    // Periodically clean up stale connections
    this._cleanupInterval = setInterval(() => this._cleanup(), 30000);
  }

  /**
   * Get or create an SSH connection for the given credentials.
   * Returns a connected ssh2 Client.
   */
  async getConnection(username, password) {
    const key = `${username}@localhost`;
    const existing = this.pool.get(key);

    // Reuse existing healthy connection
    if (existing && existing.conn && !existing.busy) {
      try {
        // Test if connection is still alive
        await this.exec(existing.conn, 'echo ok', 3000);
        existing.lastUsed = Date.now();
        return existing.conn;
      } catch {
        // Connection is dead, remove it
        this._removeConnection(key);
      }
    }

    // Create new connection
    const conn = await this._createConnection(username, password);
    this.pool.set(key, { conn, lastUsed: Date.now(), busy: false, username, password });
    return conn;
  }

  /**
   * Create a new SSH connection.
   */
  _createConnection(username, password) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timeout'));
      }, this.READY_TIMEOUT_MS);

      conn
        .on('ready', () => {
          clearTimeout(timeout);
          resolve(conn);
        })
        .on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        })
        .on('close', () => {
          // Remove from pool on close
          for (const [key, entry] of this.pool.entries()) {
            if (entry.conn === conn) {
              this.pool.delete(key);
              break;
            }
          }
        })
        .connect({
          host: 'localhost',
          port: 22,
          username,
          password,
          readyTimeout: this.READY_TIMEOUT_MS,
        });
    });
  }

  /**
   * Execute a single command over SSH. Returns { output, exitCode }.
   */
  exec(conn, command, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream
          .on('close', (code) => {
            clearTimeout(timeout);
            resolve({
              output: stdout.trim(),
              stderr: stderr.trim(),
              exitCode: code,
            });
          })
          .on('data', (data) => {
            stdout += data.toString();
          })
          .stderr.on('data', (data) => {
            stderr += data.toString();
          });
      });
    });
  }

  /**
   * Execute multiple commands in parallel. Returns { key: { output, exitCode } }.
   */
  async execMultiple(conn, commandMap, timeoutMs = 30000) {
    const entries = Object.entries(commandMap);
    const results = {};

    const promises = entries.map(async ([key, cmd]) => {
      try {
        results[key] = await this.exec(conn, cmd, timeoutMs);
      } catch (err) {
        results[key] = { output: '', stderr: err.message, exitCode: -1 };
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Execute a command with sudo using password piping.
   */
  async execSudo(conn, command, sudoPassword) {
    const sudoCmd = `echo "${sudoPassword.replace(/"/g, '\\"')}" | sudo -S ${command}`;
    return this.exec(conn, sudoCmd);
  }

  /**
   * Remove a connection from the pool and close it.
   */
  _removeConnection(key) {
    const entry = this.pool.get(key);
    if (entry) {
      try { entry.conn.end(); } catch {}
      this.pool.delete(key);
    }
  }

  /**
   * Clean up idle connections.
   */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.pool.entries()) {
      if (now - entry.lastUsed > this.POOL_TIMEOUT_MS) {
        this._removeConnection(key);
      }
    }
  }

  /**
   * Close all connections and stop cleanup.
   */
  destroy() {
    clearInterval(this._cleanupInterval);
    for (const [key] of this.pool.entries()) {
      this._removeConnection(key);
    }
  }
}

module.exports = new SSHManager();
