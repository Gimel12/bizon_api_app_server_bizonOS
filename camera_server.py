#!/usr/bin/env python3
import cv2
import uvicorn
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
import threading
import time
import numpy as np
from typing import Optional
import asyncio
from fastapi.responses import StreamingResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import os
import base64

app = FastAPI(title="Bizon-Tech Camera Server")

# Add CORS middleware to allow requests from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables
camera = None
camera_lock = threading.Lock()
last_frame = None
frame_count = 0
is_streaming = False

# Camera settings
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480
CAMERA_FPS = 15

def get_camera():
    """Get or initialize the camera"""
    global camera
    if camera is None:
        try:
            camera = cv2.VideoCapture(0)  # 0 is usually the default camera
            camera.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
            camera.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
            camera.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
            print(f"Camera initialized: {camera.isOpened()}")
        except Exception as e:
            print(f"Error initializing camera: {e}")
            return None
    return camera

def release_camera():
    """Release the camera"""
    global camera
    if camera is not None:
        camera.release()
        camera = None
        print("Camera released")

def camera_thread():
    """Thread to continuously capture frames from the camera"""
    global last_frame, frame_count, is_streaming
    print("Camera thread started")
    
    while is_streaming:
        with camera_lock:
            cam = get_camera()
            if cam is None or not cam.isOpened():
                time.sleep(0.1)
                continue
                
            ret, frame = cam.read()
            if ret:
                # Convert to JPEG
                _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                last_frame = buffer.tobytes()
                frame_count += 1
        
        # Sleep to maintain the desired frame rate
        time.sleep(1.0 / CAMERA_FPS)
    
    print("Camera thread stopped")

@app.on_event("startup")
async def startup_event():
    """Start the camera thread when the server starts"""
    global is_streaming
    is_streaming = True
    threading.Thread(target=camera_thread, daemon=True).start()

@app.on_event("shutdown")
async def shutdown_event():
    """Release the camera when the server shuts down"""
    global is_streaming
    is_streaming = False
    release_camera()

@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "Bizon-Tech Camera Server is running"}

@app.get("/api/camera-stream", response_class=HTMLResponse)
async def camera_stream_html():
    """Stream the camera feed as an HTML page with embedded image"""
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Bizon-Tech Camera Stream</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                margin: 0;
                padding: 0;
                background-color: #000;
                color: #fff;
                font-family: Arial, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                overflow: hidden;
            }
            #stream-container {
                width: 100%;
                height: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
                position: relative;
            }
            #stream {
                max-width: 100%;
                max-height: 100vh;
                object-fit: contain;
            }
            .loading {
                display: none;
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                text-align: center;
            }
            .status {
                position: absolute;
                bottom: 10px;
                right: 10px;
                background-color: rgba(0, 0, 0, 0.5);
                padding: 5px 10px;
                border-radius: 4px;
                font-size: 12px;
            }
        </style>
    </head>
    <body>
        <div id="stream-container">
            <img id="stream" src="/api/camera-feed" alt="Camera Stream">
            <div id="loading" class="loading">Loading camera...</div>
            <div id="status" class="status">Connected</div>
        </div>
        
        <script>
            const stream = document.getElementById('stream');
            const loading = document.getElementById('loading');
            const status = document.getElementById('status');
            let errorCount = 0;
            let isLoading = false;
            
            function updateImage() {
                // Only update if not currently loading
                if (!isLoading) {
                    isLoading = true;
                    
                    // Create a new image element
                    const newImg = new Image();
                    
                    // Set up event handlers
                    newImg.onload = function() {
                        // Replace the src of the visible image
                        stream.src = newImg.src;
                        errorCount = 0;
                        isLoading = false;
                        status.textContent = 'Connected';
                        status.style.color = '#4CAF50';
                    };
                    
                    newImg.onerror = function() {
                        errorCount++;
                        isLoading = false;
                        
                        if (errorCount > 5) {
                            status.textContent = 'Connection error';
                            status.style.color = '#F44336';
                        }
                    };
                    
                    // Start loading the new image
                    newImg.src = '/api/camera-feed?t=' + new Date().getTime();
                }
            }
            
            // Update every 200ms (5fps) - more stable than 100ms
            setInterval(updateImage, 200);
        </script>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)

@app.get("/api/camera-feed")
async def camera_feed():
    """Get a single frame from the camera"""
    global last_frame
    
    if last_frame is None:
        with camera_lock:
            cam = get_camera()
            if cam is None or not cam.isOpened():
                return Response(content="Camera not available", status_code=500)
                
            ret, frame = cam.read()
            if not ret:
                return Response(content="Failed to capture image", status_code=500)
                
            # Convert to JPEG
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
            snapshot = buffer.tobytes()
    else:
        snapshot = last_frame
        
    return Response(content=snapshot, media_type="image/jpeg")

@app.get("/api/camera-status")
async def camera_status():
    """Get the camera status"""
    global frame_count, is_streaming
    
    with camera_lock:
        cam = get_camera()
        is_open = cam is not None and cam.isOpened()
    
    return JSONResponse({
        "is_open": is_open,
        "is_streaming": is_streaming,
        "frame_count": frame_count,
        "resolution": f"{CAMERA_WIDTH}x{CAMERA_HEIGHT}",
        "fps": CAMERA_FPS
    })

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
