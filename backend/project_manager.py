import os
import json
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel

# Project storage location
PROJECTS_DIR = "D:/ChameleonProjects"

class ExclusionRule(BaseModel):
    type: str  # 'domain', 'url', 'regex'
    value: str

class MatchReplaceRule(BaseModel):
    enabled: bool = True
    item: str  # 'Request header', 'Response header', 'Request body', 'Response body', 'Request first line', 'Response first line'
    match: str
    replace: str
    isRegex: bool = False
    comment: str = ""

class CapturedRequest(BaseModel):
    id: str
    method: str
    url: str
    headers: dict
    body: Optional[str] = None
    resourceType: str = ""
    timestamp: float = 0
    response: Optional[dict] = None

class Project(BaseModel):
    name: str
    created: str
    lastModified: str
    targetUrl: str = "https://example.com"
    requests: List[CapturedRequest] = []
    exclusionRules: List[ExclusionRule] = []
    historyFilter: str = ""
    hideStatic: bool = False
    repeaterTabs: List[dict] = []
    matchReplaceRules: List[MatchReplaceRule] = []

class ProjectManager:
    def __init__(self):
        self.ensure_projects_dir()
    
    def ensure_projects_dir(self):
        """Create projects directory if it doesn't exist"""
        if not os.path.exists(PROJECTS_DIR):
            os.makedirs(PROJECTS_DIR)
    
    def get_project_path(self, name: str) -> str:
        """Get the file path for a project"""
        # Sanitize name for filesystem
        safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).strip()
        return os.path.join(PROJECTS_DIR, f"{safe_name}.json")
    
    def list_projects(self) -> List[dict]:
        """List all saved projects"""
        self.ensure_projects_dir()
        projects = []
        for filename in os.listdir(PROJECTS_DIR):
            if filename.endswith('.json'):
                filepath = os.path.join(PROJECTS_DIR, filename)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        projects.append({
                            "name": data.get("name", filename[:-5]),
                            "created": data.get("created", ""),
                            "lastModified": data.get("lastModified", ""),
                            "targetUrl": data.get("targetUrl", ""),
                            "requestCount": len(data.get("requests", []))
                        })
                except Exception:
                    pass
        return sorted(projects, key=lambda x: x.get("lastModified", ""), reverse=True)
    
    def create_project(self, name: str) -> Project:
        """Create a new project"""
        now = datetime.now().isoformat()
        project = Project(
            name=name,
            created=now,
            lastModified=now
        )
        self.save_project(project)
        return project
    
    def load_project(self, name: str) -> Optional[Project]:
        """Load a project by name"""
        filepath = self.get_project_path(name)
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return Project(**data)
        except Exception as e:
            print(f"Error loading project: {e}")
            return None
    
    def save_project(self, project: Project) -> bool:
        """Save a project"""
        try:
            self.ensure_projects_dir()
            project.lastModified = datetime.now().isoformat()
            filepath = self.get_project_path(project.name)
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(project.dict(), f, indent=2)
            return True
        except Exception as e:
            print(f"Error saving project: {e}")
            return False
    
    def delete_project(self, name: str) -> bool:
        """Delete a project"""
        filepath = self.get_project_path(name)
        if os.path.exists(filepath):
            os.remove(filepath)
            return True
        return False
