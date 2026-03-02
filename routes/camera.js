const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

// Global camera state
let activeCameraProcess = null;
let activeClients = 0;

/**
 * GET /api/camera-stream
 * HTML page that embeds the MJPEG camera stream.
 */
router.get('/camera-stream', (req, res) => {
  console.log('Camera stream endpoint called');
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Camera Stream</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        body, html {
          margin: 0;
          padding: 0;
          height: 100%;
          width: 100%;
          overflow: hidden;
          background: #000;
        }
        img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      <img src="/api/camera-feed" alt="Camera Feed">
    </body>
    </html>
  `);
});

/**
 * GET /api/camera-feed-disconnect
 * Handle client disconnection notification.
 */
router.get('/camera-feed-disconnect', (req, res) => {
  console.log('Client disconnection notification received');
  activeClients--;
  if (activeClients <= 0) {
    activeClients = 0;
    if (activeCameraProcess) {
      console.log('No more clients, killing ffmpeg process');
      activeCameraProcess.kill();
      activeCameraProcess = null;
    }
  }
  res.status(200).send('OK');
});

/**
 * GET /api/camera-feed
 * Raw MJPEG stream from the system camera via ffmpeg.
 */
router.get('/camera-feed', (req, res) => {
  console.log('Camera feed endpoint called');
  activeClients++;

  req.socket.setTimeout(0);
  if (res.connection) res.connection.setTimeout(0);

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Connection', 'keep-alive');

  if (activeCameraProcess) {
    console.log('Using existing ffmpeg process');
    setupResponseHandlers(res, req);
    return;
  }

  startNewFfmpegProcess(res, req);
});

function startNewFfmpegProcess(res, req) {
  console.log('Starting new ffmpeg process');

  if (activeCameraProcess) {
    activeCameraProcess.kill();
    activeCameraProcess = null;
  }

  const ffmpeg = spawn('ffmpeg', [
    '-f', 'v4l2',
    '-i', '/dev/video0',
    '-s', '640x480',
    '-r', '15',
    '-f', 'mjpeg',
    '-q:v', '5',
    '-b:v', '1500k',
    '-',
  ]);

  activeCameraProcess = ffmpeg;
  setupResponseHandlers(res, req);

  ffmpeg.on('error', (err) => {
    console.error('Failed to start ffmpeg:', err);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/html');
      res.send(`
        <html>
        <body style="background-color: black; color: white; font-family: Arial; text-align: center; padding-top: 100px;">
          <h2>Camera Feed Unavailable</h2>
          <p>Please install ffmpeg on the server to enable camera streaming:</p>
          <pre>sudo apt update && sudo apt install ffmpeg</pre>
          <p>Also ensure your webcam is connected and accessible at /dev/video0</p>
        </body>
        </html>
      `);
    }
    activeCameraProcess = null;
    activeClients--;
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`ffmpeg process exited with code ${code} and signal ${signal}`);
    if (activeCameraProcess === ffmpeg) {
      activeCameraProcess = null;
    }
  });
}

function setupResponseHandlers(res, req) {
  let isResponseActive = true;

  req.on('close', () => {
    console.log('Client disconnected');
    isResponseActive = false;
    activeClients--;
    if (activeClients <= 0) {
      activeClients = 0;
      if (activeCameraProcess) {
        console.log('No more clients, killing ffmpeg process');
        activeCameraProcess.kill();
        activeCameraProcess = null;
      }
    }
  });

  req.on('error', (err) => {
    console.error('Request error:', err);
    isResponseActive = false;
    activeClients--;
  });

  if (activeCameraProcess) {
    activeCameraProcess.stdout.on('data', (data) => {
      if (!isResponseActive) return;
      try {
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n');
        res.write(`Content-Length: ${data.length}\r\n\r\n`);
        res.write(data);
        res.write('\r\n');
      } catch (err) {
        console.error('Error writing to response:', err);
        isResponseActive = false;
      }
    });

    activeCameraProcess.stderr.on('data', (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });
  } else {
    res.status(500).send('No active camera process');
    isResponseActive = false;
  }
}

module.exports = router;
