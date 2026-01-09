from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
import asyncio
import json
import logging
import os
import sys
from browser import BrowserManager
from project_manager import ProjectManager, Project, CapturedRequest, ExclusionRule

# Logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Project Manager
project_manager = ProjectManager()

# Global Browser Manager
active_connections = []

async def broadcast_message(message: dict):
    for connection in active_connections:
        try:
            await connection.send_json(message)
        except Exception as e:
            logger.error(f"Error sending to websocket: {e}")

async def on_browser_event(data: dict):
    await broadcast_message({"type": "capture", "data": data})

browser_manager = BrowserManager(on_request_captured=on_browser_event)

# --- Project API Endpoints ---

@app.get("/api/projects")
async def list_projects():
    """List all saved projects"""
    return project_manager.list_projects()

class CreateProjectRequest(BaseModel):
    name: str

@app.post("/api/projects")
async def create_project(req: CreateProjectRequest):
    """Create a new project"""
    project = project_manager.create_project(req.name)
    return {"success": True, "project": project.dict()}

@app.get("/api/projects/{name}")
async def get_project(name: str):
    """Load a project by name"""
    project = project_manager.load_project(name)
    if project:
        # Sync rules to browser manager
        browser_manager.match_replace_rules = project.matchReplaceRules
        return project.dict()
    return {"error": "Project not found"}

class SaveProjectRequest(BaseModel):
    name: str
    targetUrl: str = "https://example.com"
    requests: List[dict] = []
    exclusionRules: List[dict] = []
    historyFilter: str = ""
    hideStatic: bool = False
    repeaterTabs: List[dict] = []
    matchReplaceRules: List[dict] = []

@app.put("/api/projects/{name}")
async def save_project(name: str, req: SaveProjectRequest):
    """Save/update a project"""
    existing = project_manager.load_project(name)
    if not existing:
        existing = project_manager.create_project(name)
    
    existing.targetUrl = req.targetUrl
    existing.requests = [CapturedRequest(**r) for r in req.requests]
    existing.exclusionRules = [ExclusionRule(**r) for r in req.exclusionRules]
    existing.historyFilter = req.historyFilter
    existing.hideStatic = req.hideStatic
    existing.repeaterTabs = req.repeaterTabs
    existing.matchReplaceRules = [MatchReplaceRule(**r) for r in req.matchReplaceRules]
    
    # Sync rules to browser manager
    browser_manager.match_replace_rules = existing.matchReplaceRules
    
    success = project_manager.save_project(existing)
    return {"success": success}

@app.delete("/api/projects/{name}")
async def delete_project(name: str):
    """Delete a project"""
    success = project_manager.delete_project(name)
    return {"success": success}

# --- Browser Control ---

class StartRequest(BaseModel):
    url: str

@app.post("/start")
async def start_browser(req: StartRequest):
    asyncio.create_task(browser_manager.start(req.url))
    return {"status": "starting", "url": req.url}

@app.post("/stop")
async def stop_browser():
    await browser_manager.stop()
    return {"status": "stopped"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            cmd = data.get("command")
            
            if cmd == "replay":
                req_data = data.get("request")
                if req_data:
                    result = await browser_manager.replay_request(req_data)
                    await websocket.send_json({
                        "type": "replay_response",
                        "original_id": req_data.get("id"),
                        "tab_id": data.get("tabId"),
                        "response": result
                    })
                    
            elif cmd == "start":
                url = data.get("url")
                if url:
                    asyncio.create_task(browser_manager.start(url))

            elif cmd == "stop":
                await browser_manager.stop()
            
            # Intercept control commands
            elif cmd == "intercept_requests":
                enabled = data.get("enabled", False)
                browser_manager.set_intercept_requests(enabled)
                await websocket.send_json({
                    "type": "intercept_status",
                    "intercept_requests": enabled,
                    "intercept_responses": browser_manager.intercept_responses
                })
            
            elif cmd == "intercept_responses":
                enabled = data.get("enabled", False)
                browser_manager.set_intercept_responses(enabled)
                await websocket.send_json({
                    "type": "intercept_status",
                    "intercept_requests": browser_manager.intercept_requests,
                    "intercept_responses": enabled
                })
            
            elif cmd == "forward":
                item_id = data.get("id")
                modified = data.get("modified")
                success = browser_manager.forward_item(item_id, modified)
                await websocket.send_json({
                    "type": "forward_result",
                    "id": item_id,
                    "success": success
                })
            
            elif cmd == "drop":
                item_id = data.get("id")
                success = browser_manager.drop_item(item_id)
                await websocket.send_json({
                    "type": "drop_result",
                    "id": item_id,
                    "success": success
                })

    except WebSocketDisconnect:
        active_connections.remove(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        if websocket in active_connections:
            active_connections.remove(websocket)

# --- Static File Serving (for bundled exe) ---
# Check if running from bundled exe
def get_static_dir():
    if getattr(sys, 'frozen', False):
        # Running as bundled exe
        path = os.path.join(sys._MEIPASS, 'static')
        print(f"[DEBUG] Running as bundled exe, static dir: {path}")
        return path
    else:
        # Running in development
        base = os.path.dirname(__file__)
        path = os.path.join(base, '..', 'frontend', 'dist')
        print(f"[DEBUG] Running in dev mode, static dir: {path}")
        return path

static_dir = get_static_dir()
print(f"[DEBUG] Static dir exists: {os.path.exists(static_dir)}")
if os.path.exists(static_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")
    
    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(static_dir, "index.html"))
    
    @app.get("/{path:path}")
    async def serve_static(path: str):
        file_path = os.path.join(static_dir, path)
        if os.path.exists(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(static_dir, "index.html"))

if __name__ == "__main__":
    import uvicorn
    import webbrowser
    import threading
    
    print("Starting Chameleon server...")
    print()
    print("=" * 50)
    print("  Open your browser to: http://localhost:8000")
    print("=" * 50)
    print()
    
    # Auto-open browser after short delay
    def open_browser():
        import time
        time.sleep(2)
        webbrowser.open("http://localhost:8000")
    
    threading.Thread(target=open_browser, daemon=True).start()
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
