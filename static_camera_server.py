#!/usr/bin/env python3
import cv2
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import threading
import time
import base64
import io

app = FastAPI(title="Bizon-Tech Static Camera Server")

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
    return {"message": "Bizon-Tech Static Camera Server is running"}

@app.get("/api/camera-frame")
async def camera_frame():
    """Get a base64 encoded camera frame"""
    global last_frame
    
    if last_frame is None:
        with camera_lock:
            cam = get_camera()
            if cam is None or not cam.isOpened():
                return JSONResponse(
                    content={"error": "Camera not available"},
                    status_code=500
                )
                
            ret, frame = cam.read()
            if not ret:
                return JSONResponse(
                    content={"error": "Failed to capture image"},
                    status_code=500
                )
                
            # Convert to JPEG
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
            snapshot = buffer.tobytes()
    else:
        snapshot = last_frame
    
    # Convert to base64
    base64_image = base64.b64encode(snapshot).decode('utf-8')
    
    return JSONResponse({
        "image": base64_image,
        "timestamp": time.time(),
        "width": CAMERA_WIDTH,
        "height": CAMERA_HEIGHT
    })

@app.get("/api/camera-jpeg")
async def camera_jpeg():
    """Get a JPEG image from the camera"""
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
