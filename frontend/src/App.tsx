import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { Play, Square, Trash2, Search, Send, X, Filter, FolderOpen, Plus, Save, ArrowLeft, ArrowUp, ArrowDown, GripVertical, Upload, Check, Eye, History, Repeat, Loader2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Helper for Highlighted Textarea
const HighlightedTextarea = ({ value, onChange, placeholder, readOnly, className }: { value: string, onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void, placeholder?: string, readOnly?: boolean, className?: string }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleScroll = () => {
    if (textareaRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const parts = value.split('\r\n\r\n');
  const headers = parts[0];
  const body = parts.slice(1).join('\r\n\r\n');

  return (
    <div className={`relative flex-1 flex flex-col min-h-0 bg-[#1e1e1e] ${className}`}>
      {/* Overlay for highlighting */}
      <div
        ref={overlayRef}
        className="absolute inset-0 p-2 font-mono text-xs leading-relaxed pointer-events-none whitespace-pre-wrap break-words overflow-hidden"
        style={{ fontFamily: 'monospace' }}
      >
        <span className="text-[#9cdcfe]">{headers}</span>
        {parts.length > 1 && (
          <>
            {'\r\n\r\n'}
            <span className="text-[#ce9178]">{body}</span>
          </>
        )}
      </div>

      {/* Transparent Textarea for editing */}
      <textarea
        ref={textareaRef}
        className="relative z-10 flex-1 w-full h-full bg-transparent p-2 font-mono text-xs leading-relaxed focus:outline-none resize-none text-transparent caret-white"
        style={{ fontFamily: 'monospace' }}
        value={value}
        onChange={onChange}
        onScroll={handleScroll}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
};

// API base URL - works with both dev and bundled
const API_BASE = window.location.origin;
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${protocol}//${window.location.host}/ws`;

interface RequestData {
  id: string;
  type: 'request';
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  resourceType: string;
  timestamp: number;
  seq?: number; // Sequence number for ordering
  pending?: boolean; // Waiting for forward/drop decision
  dropped?: boolean; // Was dropped by user
  interceptResponse?: boolean; // Intercept response for this request
  response?: ResponseData;
}

interface ResponseData {
  type: 'response';
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  request_url: string;
}

interface ExclusionRule {
  type: 'domain' | 'url' | 'regex';
  value: string;
}

interface MatchReplaceRule {
  enabled: boolean;
  item: string; // 'Request header', 'Response header', 'Request body', 'Response body', 'Request first line', 'Response first line'
  match: string;
  replace: string;
  isRegex: boolean;
  comment: string;
}

interface ProjectSummary {
  name: string;
  created: string;
  lastModified: string;
  targetUrl: string;
  requestCount: number;
}

// Try to beautify JSON string
function beautifyJson(str: string): string {
  if (!str) return str;
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return str; // Not valid JSON, return as-is
  }
}

// Convert request object to raw HTTP format
function requestToRaw(req: RequestData): string {
  try {
    const urlObj = new URL(req.url);
    let raw = `${req.method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\n`;
    raw += `Host: ${urlObj.host}\r\n`;
    Object.entries(req.headers).forEach(([key, value]) => {
      // Skip HTTP/2 pseudo-headers and host (already added)
      if (key.startsWith(':') || key.toLowerCase() === 'host') {
        return;
      }
      raw += `${key}: ${value}\r\n`;
    });
    raw += `\r\n`;
    if (req.body) raw += beautifyJson(req.body);
    return raw;
  } catch {
    return `${req.method} ${req.url} HTTP/1.1\r\n\r\n`;
  }
}

function parseRawRequest(raw: string): { method: string; url: string; headers: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/);
  const firstLine = lines[0] || '';
  const [method, path] = firstLine.split(' ');
  const headers: Record<string, string> = {};
  let bodyStartIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') { bodyStartIndex = i + 1; break; }
    const colonIndex = lines[i].indexOf(':');
    if (colonIndex > 0) {
      headers[lines[i].substring(0, colonIndex).trim()] = lines[i].substring(colonIndex + 1).trim();
    }
  }
  const body = bodyStartIndex > 0 ? lines.slice(bodyStartIndex).join('\n') : '';
  const host = headers['Host'] || headers['host'] || 'localhost';
  const url = path?.startsWith('http') ? path : `https://${host}${path || '/'}`;
  return { method: method || 'GET', url, headers, body };
}

// Syntax highlighting with VS Code-style dark theme colors


// ============== PROJECT SELECTION SCREEN ==============
function ProjectSelector({ onSelect }: { onSelect: (name: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [newProjectName, setNewProjectName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/projects`)
      .then(r => r.json())
      .then(setProjects)
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!newProjectName.trim()) return;
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjectName.trim() })
    });
    if (res.ok) {
      onSelect(newProjectName.trim());
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const projectData = JSON.parse(text);

      if (!projectData.name) {
        setImportStatus('Invalid project file: missing name');
        return;
      }

      // Save the imported project
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectData.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: text
      });

      if (res.ok) {
        setImportStatus(`Imported "${projectData.name}" successfully!`);
        // Refresh project list
        const updatedProjects = await fetch(`${API_BASE}/api/projects`).then(r => r.json());
        setProjects(updatedProjects);
        setTimeout(() => setImportStatus(null), 3000);
      } else {
        setImportStatus('Failed to import project');
      }
    } catch {
      setImportStatus('Invalid project file format');
    }

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="h-screen bg-[#1e1e1e] flex items-center justify-center">
      <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl w-[500px] max-h-[600px] overflow-hidden">
        <div className="p-4 border-b border-[#3c3c3c]">
          <h1 className="text-xl font-bold text-[#e06c00]">Chameleon 🦎</h1>
          <p className="text-xs text-[#6e6e6e] mt-1">Select or create a project to get started</p>
        </div>

        {importStatus && (
          <div className={cn("px-4 py-2 text-xs", importStatus.includes('success') ? "bg-[#2ea043]/20 text-[#3fb950]" : "bg-[#da3633]/20 text-[#f85149]")}>
            {importStatus}
          </div>
        )}

        {showNewForm ? (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <button onClick={() => setShowNewForm(false)} className="text-[#6e6e6e] hover:text-white">
                <ArrowLeft size={16} />
              </button>
              <span className="text-sm font-bold">New Project</span>
            </div>
            <input
              className="w-full bg-[#3c3c3c] border border-[#555] rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-[#007fd4]"
              placeholder="Project name..."
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <button
              onClick={handleCreate}
              className="w-full bg-[#e06c00] hover:bg-[#ff8c00] text-white py-2 rounded font-bold text-sm"
            >
              Create Project
            </button>
          </div>
        ) : (
          <>
            <div className="p-4 border-b border-[#3c3c3c] flex gap-2">
              <button
                onClick={() => setShowNewForm(true)}
                className="flex-1 flex items-center justify-center gap-2 bg-[#e06c00] hover:bg-[#ff8c00] text-white py-3 rounded font-bold text-sm"
              >
                <Plus size={16} /> New Project
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center gap-2 bg-[#3c3c3c] hover:bg-[#4c4c4c] text-white px-4 py-3 rounded font-bold text-sm border border-[#555]"
                title="Import project from JSON file"
              >
                <Upload size={16} /> Import
              </button>
            </div>

            <div className="max-h-[350px] overflow-y-auto">
              {loading ? (
                <div className="p-8 text-center text-[#6e6e6e]">Loading...</div>
              ) : projects.length === 0 ? (
                <div className="p-8 text-center text-[#6e6e6e]">
                  <FolderOpen size={32} className="mx-auto mb-2 opacity-50" />
                  <div>No projects yet</div>
                  <div className="text-[10px] mt-1">Projects are saved to D:/ChameleonProjects/</div>
                </div>
              ) : (
                projects.map(p => (
                  <div
                    key={p.name}
                    onClick={() => onSelect(p.name)}
                    className="px-4 py-3 border-b border-[#3c3c3c] hover:bg-[#2a2d2e] cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm">{p.name}</span>
                      <span className="text-[10px] text-[#6e6e6e]">{p.requestCount} requests</span>
                    </div>
                    <div className="text-[10px] text-[#555] mt-0.5">
                      Last modified: {p.lastModified ? new Date(p.lastModified).toLocaleString() : 'Never'}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============== MAIN APP ==============
function App() {
  const [currentProject, setCurrentProject] = useState<string | null>(null);

  // If no project selected, show project selector
  if (!currentProject) {
    return <ProjectSelector onSelect={name => { setCurrentProject(name); }} />;
  }

  return <MainApp projectName={currentProject} onBack={() => setCurrentProject(null)} />;
}

function MainApp({ projectName, onBack }: { projectName: string; onBack: () => void }) {
  const [isConnected, setIsConnected] = useState(false);
  const [browserActive, setBrowserActive] = useState(false);
  const [requests, setRequests] = useState<RequestData[]>([]);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [rawRequest, setRawRequest] = useState("");
  const [rawResponse, setRawResponse] = useState("");
  const [hideStatic, setHideStatic] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);

  const ws = useRef<WebSocket | null>(null);

  // Exclusion filter
  const [exclusionRules, setExclusionRules] = useState<ExclusionRule[]>([]);
  const [newExcludeValue, setNewExcludeValue] = useState("");
  const [newExcludeType, setNewExcludeType] = useState<'domain' | 'url' | 'regex'>('domain');
  const [showExcludePanel, setShowExcludePanel] = useState(false);
  const [matchReplaceRules, setMatchReplaceRules] = useState<MatchReplaceRule[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; reqUrl: string; reqId?: string; isPending?: boolean } | null>(null);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc'); // desc = newest first
  const autoScroll = true; // Auto-scroll enabled by default
  const requestListRef = useRef<HTMLDivElement>(null);

  // Resizable panels
  const [sidebarWidth, setSidebarWidth] = useState(450);
  const [requestPanelWidth, setRequestPanelWidth] = useState(50); // percentage
  const isResizingSidebar = useRef(false);
  const isResizingPanels = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const seqCounter = useRef(0); // Sequence counter for request ordering

  // Interception state
  const [interceptRequests, setInterceptRequests] = useState(false);
  const [pendingResponses, setPendingResponses] = useState<Array<{ id: string; url: string; status: number; body: string; headers: Record<string, string> }>>([]);
  const [selectedPendingResId, setSelectedPendingResId] = useState<string | null>(null);

  // Tabs
  const [mainTab, setMainTab] = useState<'proxy' | 'repeater'>('proxy');
  const [proxyTab, setProxyTab] = useState<'intercept' | 'history' | 'match-replace'>('intercept');

  // Repeater State
  // Repeater State
  interface RepeaterTab {
    id: string;
    name: string;
    request: string;
    response: string;
    sending: boolean;
  }
  const [repeaterTabs, setRepeaterTabs] = useState<RepeaterTab[]>([{
    id: '1', name: '1',
    request: '',
    response: '',
    sending: false
  }]);
  const [activeRepeaterTabId, setActiveRepeaterTabId] = useState<string>('1');

  // Load project on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectName)}`)
      .then(r => r.json())
      .then(data => {
        if (!data.error) {
          const requestsArray = data.requests || [];
          // Assign sequence numbers - first item in array (newest) gets highest seq
          const loadedRequests = requestsArray.map((r: RequestData, i: number) => ({
            ...r,
            seq: r.seq ?? (requestsArray.length - i)
          }));
          seqCounter.current = requestsArray.length;
          setRequests(loadedRequests);
          setExclusionRules(data.exclusionRules || []);
          setFilterText(data.historyFilter || "");
          setHideStatic(data.hideStatic || false);
          if (data.repeaterTabs && data.repeaterTabs.length > 0) {
            setRepeaterTabs(data.repeaterTabs.map((t: any) => ({ ...t, sending: false })));
            setActiveRepeaterTabId(data.repeaterTabs[0].id);
          }
          if (data.matchReplaceRules) {
            setMatchReplaceRules(data.matchReplaceRules);
          }
        }
      })
      .catch(() => { });
  }, [projectName]);

  // Handle resize mouse events
  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (isResizingSidebar.current && containerRef.current) {
        const containerRect = containerRef.current.getBoundingClientRect();
        const newWidth = e.clientX - containerRect.left;
        setSidebarWidth(Math.max(200, Math.min(newWidth, window.innerWidth - 400)));
      }
      if (isResizingPanels.current && containerRef.current) {
        const panelArea = containerRef.current.querySelector('[data-panel-area]') as HTMLElement;
        if (panelArea) {
          const panelRect = panelArea.getBoundingClientRect();
          const relativeX = e.clientX - panelRect.left;
          const percentage = (relativeX / panelRect.width) * 100;
          setRequestPanelWidth(Math.max(20, Math.min(percentage, 80)));
        }
      }
    };

    const handleMouseUp = () => {
      isResizingSidebar.current = false;
      isResizingPanels.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const startSidebarResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    isResizingSidebar.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const startPanelResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    isResizingPanels.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Auto-save every 30 seconds
  const saveProject = useCallback(async () => {
    setIsSaving(true);
    try {
      await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName,
          requests: requests.map(r => ({ ...r, response: r.response })),
          exclusionRules,
          historyFilter: filterText,
          hideStatic,
          repeaterTabs: repeaterTabs.map(t => ({ ...t, sending: false })),
          matchReplaceRules
        })
      });
      setLastSaved(new Date());
      setShowSaveSuccess(true);
      setTimeout(() => setShowSaveSuccess(false), 2000);
    } catch { }
    setIsSaving(false);
  }, [projectName, requests, exclusionRules, filterText, hideStatic, repeaterTabs, matchReplaceRules]);

  useEffect(() => {
    const interval = setInterval(saveProject, 30000);
    return () => clearInterval(interval);
  }, [saveProject]);

  // WebSocket connection
  useEffect(() => {
    const connect = () => {
      ws.current = new WebSocket(WS_URL);
      ws.current.onopen = () => setIsConnected(true);
      ws.current.onclose = () => {
        setIsConnected(false);
        setTimeout(connect, 3000);
      };
      ws.current.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "capture") {
          const data = msg.data;
          if (data.type === "request") {
            const isExcluded = exclusionRules.some(rule => {
              try {
                if (rule.type === 'domain') return new URL(data.url).host.includes(rule.value);
                if (rule.type === 'url') return data.url.includes(rule.value);
                if (rule.type === 'regex') return new RegExp(rule.value).test(data.url);
              } catch { }
              return false;
            });
            if (!isExcluded) {
              setRequests(prev => {
                // Prevent duplicates by checking ID
                if (prev.some(r => r.id === data.id)) {
                  return prev;
                }
                // Assign sequence number
                seqCounter.current += 1;
                const newRequest = { ...data, seq: seqCounter.current, req_id: data.id }; // Ensure req_id is set
                return [newRequest, ...prev];
              });
              // Auto-scroll to show new request
              if (autoScroll && requestListRef.current) {
                setTimeout(() => {
                  if (requestListRef.current) {
                    if (sortOrder === 'desc') {
                      requestListRef.current.scrollTop = 0;
                    } else {
                      requestListRef.current.scrollTop = requestListRef.current.scrollHeight;
                    }
                  }
                }, 50);
              }
            }
          } else if (data.type === "response") {
            if (data.pending) {
              // Pending response - add to pendingResponses
              setPendingResponses(prev => [...prev, {
                id: data.id,
                url: data.url,
                status: data.status,
                body: data.body,
                headers: data.headers
              }]);
            } else {
              // Normal response - attach to matching request

              setRequests(prev => {
                // Use req_id from response to find matching request
                const reqIdStr = data.req_id || '';
                const idx = prev.findIndex(r => r.id === reqIdStr);
                if (idx !== -1) {
                  const copy = [...prev];
                  copy[idx] = { ...copy[idx], response: data };
                  return copy;
                }
                // Fallback: match by URL (only if req_id missing) but this is less reliable
                if (!reqIdStr) {
                  const idxUrl = prev.findIndex(r => r.url === data.url && !r.response);
                  if (idxUrl !== -1) {
                    const copy = [...prev];
                    copy[idxUrl] = { ...copy[idxUrl], response: data };
                    return copy;
                  }
                }
                return prev;
              });
            }
          }

        } else if (msg.type === "replay_response") {
          const resp = msg.response;
          let rawResp = resp.error ? `Error: ${resp.error}` : `HTTP/1.1 ${resp.status}\r\n`;

          if (!resp.error && resp.headers) {
            Object.entries(resp.headers).forEach(([k, v]) => { rawResp += `${k}: ${v}\r\n`; });
          }
          rawResp += "\r\n" + beautifyJson(resp.body || '');

          setRepeaterTabs(prev => prev.map(tab => {
            if (tab.id === msg.tab_id) {
              return { ...tab, response: rawResp, sending: false };
            }
            return tab;
          }));

        }
      };
    };
    connect();
    return () => { ws.current?.close(); };
  }, [exclusionRules]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const startBrowser = () => {
    if (!isConnected) return;
    ws.current?.send(JSON.stringify({ command: "start", url: "about:blank" }));
    setBrowserActive(true);
  };

  const stopBrowser = () => {
    if (!isConnected) return;
    ws.current?.send(JSON.stringify({ command: "stop" }));
    setBrowserActive(false);
  };

  const toggleInterceptRequests = () => {
    const newState = !interceptRequests;
    setInterceptRequests(newState);
    ws.current?.send(JSON.stringify({ command: "intercept_requests", enabled: newState }));
  };

  const forwardPendingRequest = (id: string, modified?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const req = requests.find(r => r.id === id);
    // Send interceptResponse flag to backend if set
    ws.current?.send(JSON.stringify({
      command: "forward",
      id,
      modified,
      interceptResponse: req?.interceptResponse || false
    }));
    // Mark request as no longer pending
    setRequests(prev => prev.map(r => r.id === id ? { ...r, pending: false } : r));
  };

  const dropPendingRequest = (id: string) => {
    ws.current?.send(JSON.stringify({ command: "drop", id }));
    // Remove from list or mark as dropped
    setRequests(prev => prev.map(r => r.id === id ? { ...r, pending: false, dropped: true } : r));
  };

  const forwardPendingResponse = (id: string, modified?: { status?: number; headers?: Record<string, string>; body?: string }) => {
    ws.current?.send(JSON.stringify({ command: "forward", id, modified }));
    setPendingResponses(prev => prev.filter(r => r.id !== id));
    if (selectedPendingResId === id) setSelectedPendingResId(null);
  };

  const dropPendingResponse = (id: string) => {
    ws.current?.send(JSON.stringify({ command: "drop", id }));
    setPendingResponses(prev => prev.filter(r => r.id !== id));
    if (selectedPendingResId === id) setSelectedPendingResId(null);
  };

  const selectRequest = (id: string) => {
    setSelectedReqId(id);
    const req = requests.find(r => r.id === id);
    if (req) {
      setRawRequest(requestToRaw(req));
      setRawResponse(req.response ? `HTTP/1.1 ${req.response.status}\r\n${Object.entries(req.response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${beautifyJson(req.response.body)}` : "");
    }
  };

  /* Repeater Functions */
  const sendToRepeater = (reqId: string) => {
    const req = requests.find(r => r.id === reqId);
    if (req) {
      const newTabId = String(Date.now());
      const newTabName = String(repeaterTabs.length + 1);

      setRepeaterTabs(prev => [
        ...prev,
        {
          id: newTabId, name: newTabName,
          request: requestToRaw(req),
          response: '',
          sending: false
        }
      ]);
      setActiveRepeaterTabId(newTabId);
      setMainTab('repeater');
    }
  };

  const sendRepeaterRequest = () => {
    const activeTab = repeaterTabs.find(t => t.id === activeRepeaterTabId);
    if (!ws.current || !activeTab || !activeTab.request) return;

    // Set sending state
    setRepeaterTabs(prev => prev.map(t => t.id === activeRepeaterTabId ? { ...t, sending: true, response: '' } : t));

    const parsed = parseRawRequest(activeTab.request);
    ws.current.send(JSON.stringify({
      command: "replay",
      request: {
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
        id: activeRepeaterTabId
      },
      tabId: activeRepeaterTabId
    }));
  };



  const cancelRepeaterRequest = () => {
    setRepeaterTabs(prev => prev.map(t => t.id === activeRepeaterTabId ? { ...t, sending: false } : t));
  };


  const closeRepeaterTab = (tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (repeaterTabs.length <= 1) return; // Don't close last tab

    const newTabs = repeaterTabs.filter(t => t.id !== tabId);
    setRepeaterTabs(newTabs);
    if (activeRepeaterTabId === tabId) {
      setActiveRepeaterTabId(newTabs[newTabs.length - 1].id);
    }
  };

  const addRepeaterTab = () => {
    const newTabId = String(Date.now());
    const newTabName = String(repeaterTabs.length + 1);
    setRepeaterTabs(prev => [
      ...prev,
      { id: newTabId, name: newTabName, request: '', response: '', sending: false }
    ]);
    setActiveRepeaterTabId(newTabId);
  };


  const filteredRequests = requests.filter(r => {
    const matchesText = r.url.toLowerCase().includes(filterText.toLowerCase()) || r.method.toLowerCase().includes(filterText.toLowerCase());

    // Hide Static Resources Filter
    if (hideStatic) {
      const urlPath = r.url.split('?')[0].toLowerCase();
      const staticExts = ['.woff', '.woff2', '.png', '.css', '.webp', '.mp4', '.mp3', '.svg', '.jpg', '.jpeg', '.gif', '.ico', '.js'];
      if (staticExts.some(ext => urlPath.endsWith(ext))) {
        return false;
      }
    }

    const isExcluded = exclusionRules.some(rule => {
      try {
        if (rule.type === 'domain') return new URL(r.url).host.includes(rule.value);
        if (rule.type === 'url') return r.url.includes(rule.value);
        if (rule.type === 'regex') return new RegExp(rule.value).test(r.url);
      } catch { }
      return false;
    });
    return matchesText && !isExcluded;
  });

  // Sort requests by sequence number - highest seq = newest
  const sortedRequests = [...filteredRequests].sort((a, b) => {
    const seqA = a.seq ?? 0;
    const seqB = b.seq ?? 0;
    if (sortOrder === 'desc') {
      return seqB - seqA; // newest (highest seq) first
    } else {
      return seqA - seqB; // oldest (lowest seq) first
    }
  });

  // Helper function to check if a request matches an exclusion rule
  const matchesRule = (url: string, rule: ExclusionRule): boolean => {
    try {
      if (rule.type === 'domain') return new URL(url).host.includes(rule.value);
      if (rule.type === 'url') return url.includes(rule.value);
      if (rule.type === 'regex') return new RegExp(rule.value).test(url);
    } catch { }
    return false;
  };

  const addExclusionRule = () => {
    if (newExcludeValue.trim()) {
      const newRule: ExclusionRule = { type: newExcludeType, value: newExcludeValue.trim() };
      if (!exclusionRules.some(r => r.type === newRule.type && r.value === newRule.value)) {
        // Add the rule
        setExclusionRules(prev => [...prev, newRule]);
        // Remove matching requests from history
        setRequests(prev => prev.filter(req => !matchesRule(req.url, newRule)));
        setNewExcludeValue("");
      }
    }
  };

  const excludeFromContext = (type: 'domain' | 'url') => {
    if (contextMenu) {
      const value = type === 'domain' ? new URL(contextMenu.reqUrl).host : contextMenu.reqUrl;
      const newRule: ExclusionRule = { type, value };
      if (!exclusionRules.some(r => r.type === type && r.value === value)) {
        // Add the rule
        setExclusionRules(prev => [...prev, newRule]);
        // Remove matching requests from history
        setRequests(prev => prev.filter(req => !matchesRule(req.url, newRule)));
      }
      setContextMenu(null);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#1e1e1e] text-[#d4d4d4] font-mono text-xs">
      {/* Context Menu */}
      {contextMenu && (
        <div className="fixed bg-[#252526] border border-[#454545] rounded shadow-lg py-1 z-50 min-w-[200px]" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {/* Intercept Response option for pending requests */}
          {contextMenu.isPending && contextMenu.reqId && (
            <>
              <button
                onClick={() => {
                  const req = requests.find(r => r.id === contextMenu.reqId);
                  if (req) {
                    setRequests(prev => prev.map(r =>
                      r.id === contextMenu.reqId ? { ...r, interceptResponse: !r.interceptResponse } : r
                    ));
                  }
                  setContextMenu(null);
                }}
                className="w-full px-4 py-1.5 text-left text-[11px] hover:bg-[#2563eb] flex items-center gap-2 text-[#3b82f6]"
              >
                <Eye size={12} />
                {requests.find(r => r.id === contextMenu.reqId)?.interceptResponse
                  ? "✓ Intercept Response (ON)"
                  : "Intercept Response"}
              </button>
              <div className="border-t border-[#454545] my-1"></div>
            </>
          )}
          {contextMenu.reqId && (
            <button
              onClick={() => {
                if (contextMenu.reqId) sendToRepeater(contextMenu.reqId);
                setContextMenu(null);
              }}
              className="w-full px-4 py-1.5 text-left text-[11px] hover:bg-[#2ea043] hover:text-white flex items-center gap-2 text-[#2ea043]"
            >
              <Repeat size={12} /> Send to Repeater
            </button>
          )}
          <button onClick={() => excludeFromContext('domain')} className="w-full px-4 py-1.5 text-left text-[11px] hover:bg-[#094771] flex items-center gap-2">
            <X size={12} /> Exclude domain
          </button>
          <button onClick={() => excludeFromContext('url')} className="w-full px-4 py-1.5 text-left text-[11px] hover:bg-[#094771] flex items-center gap-2">
            <X size={12} /> Exclude this URL
          </button>
          <div className="border-t border-[#454545] my-1"></div>
          <button
            onClick={() => {
              try {
                const domain = new URL(contextMenu.reqUrl).host;
                setRequests(prev => prev.filter(r => {
                  try { return new URL(r.url).host !== domain; } catch { return true; }
                }));
              } catch { }
              setContextMenu(null);
            }}
            className="w-full px-4 py-1.5 text-left text-[11px] hover:bg-[#da3633] hover:text-white text-[#f85149] flex items-center gap-2"
          >
            <Trash2 size={12} /> Delete all from this domain
          </button>
          <button
            onClick={() => {
              setRequests(prev => prev.filter(r => r.url !== contextMenu.reqUrl));
              setContextMenu(null);
            }}
            className="w-full px-4 py-1.5 text-left text-[11px] hover:bg-[#da3633] hover:text-white text-[#f85149] flex items-center gap-2"
          >
            <Trash2 size={12} /> Delete this request
          </button>
        </div>
      )}

      {/* Top Bar (Global Controls) */}
      <div className="flex flex-col border-b border-[#3c3c3c] bg-[#252526]">
        {/* Main Tab Bar (Burp style top level) */}
        <div className="flex items-center text-sm font-bold">
          {/* Logo/Back */}
          <div className="h-8 flex items-center px-4 border-r border-[#3c3c3c]">
            <button onClick={() => { saveProject(); onBack(); }} className="text-[#6e6e6e] hover:text-white mr-2" title="Back to projects">
              <ArrowLeft size={14} />
            </button>
            <span className="text-[#e06c00]">{projectName}</span>
          </div>

          <button
            onClick={() => setMainTab('proxy')}
            className={cn(
              "h-8 px-4 flex items-center gap-2 border-r border-[#3c3c3c]",
              mainTab === 'proxy' ? "bg-[#3c3c3c] text-white" : "text-[#888] hover:bg-[#2d2d2d]"
            )}
          >
            Proxy
          </button>
          <button
            onClick={() => setMainTab('repeater')}
            className={cn(
              "h-8 px-4 flex items-center gap-2 border-r border-[#3c3c3c]",
              mainTab === 'repeater' ? "bg-[#3c3c3c] text-white" : "text-[#888] hover:bg-[#2d2d2d]"
            )}
          >
            Repeater
          </button>

          <div className="flex-1"></div>

          <button
            onClick={saveProject}
            disabled={isSaving}
            className={cn(
              "px-2 py-1 rounded flex items-center gap-1 text-xs mx-1",
              showSaveSuccess
                ? "text-[#2ea043]"
                : "text-[#6e6e6e] hover:text-white hover:bg-[#3c3c3c]"
            )}
            title={lastSaved ? `Last saved: ${lastSaved.toLocaleTimeString()}` : "Save project"}
          >
            {showSaveSuccess ? <Check size={14} /> : <Save size={14} />}
            <span className="hidden sm:inline">Save</span>
          </button>
          <div className="w-px h-4 bg-[#3c3c3c] mx-1"></div>

          {/* Global Status/Browser Controls */}
          <div className="flex items-center gap-2 px-2">
            {!browserActive ? (
              <button onClick={startBrowser} className="bg-[#2ea043] hover:bg-[#3fb950] text-white px-2 py-0.5 rounded text-[10px] flex items-center gap-1">
                <Play size={10} /> Browser
              </button>
            ) : (
              <button onClick={stopBrowser} className="bg-[#da3633] hover:bg-[#f85149] text-white px-2 py-0.5 rounded text-[10px] flex items-center gap-1">
                <Square size={10} /> Stop
              </button>
            )}
            <div className="flex items-center gap-1 text-[10px] ml-2 text-[#555]">
              <div className={cn("w-1.5 h-1.5 rounded-full", isConnected ? "bg-[#3fb950]" : "bg-[#f85149]")}></div>
              {isConnected ? "Connected" : "Disconnected"}
            </div>
          </div>
        </div>

        {/* Sub-Tab Bar (Proxy only) */}
        {mainTab === 'proxy' && (
          <div className="flex items-center h-7 bg-[#2d2d2d] border-t border-[#3c3c3c] pl-2">
            <button
              onClick={() => {
                setProxyTab('intercept');
                // If current selection is not pending, clear it so Intercept view looks empty
                const current = requests.find(r => r.id === selectedReqId);
                if (current && !current.pending) {
                  setSelectedReqId(null);
                  setRawRequest('');
                  setRawResponse('');
                }
              }}
              className={cn(
                "px-3 h-full text-[11px] font-medium flex items-center gap-1 border-r border-[#3c3c3c]",
                proxyTab === 'intercept' ? "bg-[#1e1e1e] text-white" : "text-[#888] hover:text-white"
              )}
            >
              Intercept
              {requests.filter(r => r.pending).length > 0 && (
                <span className="bg-[#e06c00] text-white text-[9px] px-1 rounded-full text-center min-w-[12px]">
                  {requests.filter(r => r.pending).length}
                </span>
              )}
            </button>
            <button
              onClick={() => setProxyTab('history')}
              className={cn(
                "px-3 h-full text-[11px] font-medium flex items-center gap-1 border-r border-[#3c3c3c]",
                proxyTab === 'history' ? "bg-[#1e1e1e] text-white" : "text-[#888] hover:text-white"
              )}
            >
              HTTP history
              <span className="text-[9px] text-[#555] ml-1">({requests.length})</span>
            </button>
            <button
              onClick={() => setProxyTab('match-replace')}
              className={cn(
                "px-3 h-full text-[11px] font-medium flex items-center gap-1 border-r border-[#3c3c3c]",
                proxyTab === 'match-replace' ? "bg-[#1e1e1e] text-white" : "text-[#888] hover:text-white"
              )}
            >
              Match and replace
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden" ref={containerRef}>
        {/* Left Sidebar - Only show in Proxy mode (but hide for match-replace) */}
        {mainTab === 'proxy' && proxyTab !== 'match-replace' && (
          <div style={{ width: sidebarWidth }} className="flex flex-col border-r border-[#3c3c3c] bg-[#252526] flex-shrink-0">
            {proxyTab === 'history' ? (
              <>
                {/* History View: Search & Filter */}
                <div className="p-1.5 border-b border-[#3c3c3c] flex gap-1">
                  <div className="relative flex-1">
                    <Search className="absolute left-1.5 top-1.5 text-[#6e6e6e]" size={12} />
                    <input
                      className="w-full bg-[#3c3c3c] border border-[#555] rounded pl-6 pr-2 py-1 text-[11px] focus:outline-none focus:border-[#007fd4]"
                      placeholder="Filter requests..."
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={() => setHideStatic(!hideStatic)}
                    className={cn("p-1.5 rounded flex items-center gap-1", hideStatic ? "bg-[#e06c00] text-white" : "hover:bg-[#3c3c3c] text-[#6e6e6e]")}
                    title="Hide Static Resources (.png, .css, .svg, etc.)"
                  >
                    <Filter size={12} />
                    {hideStatic && <span className="text-[10px] font-bold">Static Hidden</span>}
                  </button>
                  <button onClick={() => setShowExcludePanel(!showExcludePanel)} className={cn("p-1.5 rounded", showExcludePanel ? "bg-[#094771] text-white" : "hover:bg-[#3c3c3c] text-[#6e6e6e]")} title="Exclusions">
                    <Filter size={12} />
                  </button>
                  <button
                    onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
                    className="px-2 py-1 hover:bg-[#3c3c3c] rounded text-[#6e6e6e] flex items-center gap-1 text-[10px] border border-[#555]"
                    title={sortOrder === 'desc' ? 'Showing newest first (click for oldest first)' : 'Showing oldest first (click for newest first)'}
                  >
                    {sortOrder === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                    {sortOrder === 'desc' ? 'Newest' : 'Oldest'}
                  </button>
                  <button
                    onClick={() => {
                      if (requests.length === 0 || confirm(`Clear all ${requests.length} requests?`)) {
                        setRequests([]);
                      }
                    }}
                    className="p-1.5 hover:bg-[#da3633] rounded text-[#6e6e6e] hover:text-white"
                    title="Clear all requests"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Column Headers */}
                <div className="flex items-center gap-2 px-2 py-1 border-b border-[#3c3c3c] bg-[#2d2d2d] text-[9px] text-[#888] font-bold">
                  <span className="w-8 text-center">#</span>
                  <span className="w-12">Method</span>
                  <span className="flex-1">Path</span>
                  <span className="w-10 text-right">Status</span>
                </div>

                {showExcludePanel && (
                  <div className="p-2 border-b border-[#3c3c3c] bg-[#2d2d2d]">
                    <div className="text-[10px] text-[#6e6e6e] mb-1">Exclude by domain, URL, or regex:</div>
                    <div className="flex gap-1 mb-2">
                      <select value={newExcludeType} onChange={e => setNewExcludeType(e.target.value as any)} className="bg-[#3c3c3c] border border-[#555] rounded px-1 py-0.5 text-[10px]">
                        <option value="domain">Domain</option>
                        <option value="url">URL</option>
                        <option value="regex">Regex</option>
                      </select>
                      <input
                        className="flex-1 bg-[#3c3c3c] border border-[#555] rounded px-2 py-0.5 text-[10px] focus:outline-none"
                        placeholder={newExcludeType === 'regex' ? '.*\\.png$' : 'google.com'}
                        value={newExcludeValue}
                        onChange={e => setNewExcludeValue(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addExclusionRule()}
                      />
                      <button onClick={addExclusionRule} className="px-2 py-0.5 bg-[#e06c00] hover:bg-[#ff8c00] text-white rounded text-[10px]">Add</button>
                    </div>
                    <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                      {exclusionRules.map((rule, i) => (
                        <span key={i} className="flex items-center gap-1 bg-[#3c3c3c] px-1.5 py-0.5 rounded text-[9px]">
                          <span className={cn("px-1 rounded text-[8px]", rule.type === 'domain' && "bg-[#4ec9b0]/20 text-[#4ec9b0]", rule.type === 'url' && "bg-[#ce9178]/20 text-[#ce9178]", rule.type === 'regex' && "bg-[#dcdcaa]/20 text-[#dcdcaa]")}>{rule.type}</span>
                          {rule.value.length > 25 ? rule.value.slice(0, 25) + '...' : rule.value}
                          <button onClick={() => setExclusionRules(prev => prev.filter((_, idx) => idx !== i))} className="hover:text-[#f14c4c]"><X size={10} /></button>
                        </span>
                      ))}
                      {exclusionRules.length === 0 && <span className="text-[9px] text-[#6e6e6e] italic">No exclusions</span>}
                    </div>
                  </div>
                )}

                {/* History Request List */}
                <div className="flex-1 overflow-y-auto" ref={requestListRef}>
                  {sortedRequests.map((req) => {
                    const displayNumber = req.seq ?? 0;
                    return (
                      <div
                        key={req.id}
                        onClick={() => selectRequest(req.id)}
                        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, reqUrl: req.url, reqId: req.id, isPending: req.pending }); }}
                        className={cn(
                          "px-2 py-2 border-b border-[#3c3c3c] cursor-pointer hover:bg-[#2a2d2e] text-[12px]",
                          selectedReqId === req.id && "bg-[#094771] hover:bg-[#094771]",
                          req.pending && "bg-[#3d2800] border-l-2 border-l-[#e06c00]",
                          req.dropped && "opacity-50"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[#e06c00] w-10 text-center font-mono bg-[#2d2d2d] rounded px-1">{displayNumber}</span>
                          {req.pending && <span className="text-[8px] bg-[#e06c00] text-white px-1 rounded animate-pulse">PENDING</span>}
                          {req.dropped && <span className="text-[8px] bg-[#555] text-white px-1 rounded">DROPPED</span>}
                          <span className={cn("font-bold w-14", req.method === "GET" && "text-[#4ec9b0]", req.method === "POST" && "text-[#ce9178]", req.method === "PUT" && "text-[#dcdcaa]", req.method === "DELETE" && "text-[#f14c4c]", req.dropped && "line-through")}>{req.method}</span>
                          <span className={cn("truncate flex-1 text-[#9cdcfe]", req.dropped && "line-through")}>{(() => { try { return new URL(req.url).pathname; } catch { return req.url; } })()}</span>
                          <span className={cn("w-12 text-right", req.response ? (req.response.status < 300 ? "text-[#4ec9b0]" : req.response.status < 400 ? "text-[#dcdcaa]" : "text-[#f14c4c]") : "text-[#555]")}>{req.response?.status || '-'}</span>
                        </div>
                        <div className="text-[#6e6e6e] truncate ml-12 text-[11px]">{(() => { try { return new URL(req.url).host; } catch { return ''; } })()}</div>
                      </div>
                    );
                  })}
                  {sortedRequests.length === 0 && <div className="p-4 text-center text-[#6e6e6e]">No requests</div>}
                </div>
              </>
            ) : (
              <>
                {/* Intercept Queue View */}
                <div className="p-2 border-b border-[#3c3c3c] bg-[#2d2d2d] flex items-center justify-between">
                  <span className="font-bold text-[#e06c00]">Intercept Queue</span>
                  <span className="text-[10px] bg-[#333] px-2 py-0.5 rounded-full text-[#aaa]">
                    {requests.filter(r => r.pending).length} req, {pendingResponses.length} res
                  </span>
                </div>

                {/* Pending Items List */}
                <div className="flex-1 overflow-y-auto">
                  {/* 1. Pending Responses */}
                  {pendingResponses.length > 0 && (
                    <div className="border-b border-[#3c3c3c] bg-[#1a2733]">
                      <div className="px-2 py-1 text-[10px] font-bold text-[#3b82f6] border-b border-[#3c3c3c] flex items-center gap-2 sticky top-0 bg-[#1a2733]">
                        <span className="w-2 h-2 rounded-full bg-[#3b82f6] animate-pulse"></span>
                        Pending Responses
                      </div>
                      {pendingResponses.map(res => (
                        <div
                          key={res.id}
                          onClick={() => {
                            setSelectedPendingResId(res.id);
                            setSelectedReqId(null);
                            let raw = `HTTP/1.1 ${res.status}\r\n`;
                            Object.entries(res.headers).forEach(([k, v]) => { raw += `${k}: ${v}\r\n`; });
                            raw += `\r\n${res.body || ''}`;
                            setRawResponse(raw);
                          }}
                          className={cn(
                            "px-2 py-2 border-b border-[#3c3c3c] hover:bg-[#2a3744] text-[11px] cursor-pointer",
                            selectedPendingResId === res.id && "bg-[#1e3a5f] border-l-2 border-l-[#3b82f6]"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "font-bold w-8 text-center rounded",
                              res.status < 300 ? "text-[#4ec9b0]" : res.status < 400 ? "text-[#dcdcaa]" : "text-[#f14c4c]"
                            )}>{res.status}</span>
                            <span className="truncate flex-1 text-[#9cdcfe]">{(() => { try { return new URL(res.url).pathname; } catch { return res.url; } })()}</span>
                          </div>
                          <div className="text-[#6e6e6e] truncate text-[9px] mt-0.5">{(() => { try { return new URL(res.url).host; } catch { return ''; } })()}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 2. Pending Requests */}
                  {requests.filter(r => r.pending).length > 0 && (
                    <div className="border-b border-[#3c3c3c] bg-[#2d2d2d]">
                      <div className="px-2 py-1 text-[10px] font-bold text-[#e06c00] border-b border-[#3c3c3c] flex items-center gap-2 sticky top-0 bg-[#2d2d2d]">
                        <span className="w-2 h-2 rounded-full bg-[#e06c00] animate-pulse"></span>
                        Pending Requests
                      </div>
                      {requests.filter(r => r.pending).map(req => (
                        <div
                          key={req.id}
                          onClick={() => selectRequest(req.id)}
                          onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, reqUrl: req.url, reqId: req.id, isPending: true }); }}
                          className={cn(
                            "px-2 py-2 border-b border-[#3c3c3c] cursor-pointer hover:bg-[#3c3c3c] text-[11px]",
                            selectedReqId === req.id && "bg-[#3d2800] border-l-2 border-l-[#e06c00]"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className={cn("font-bold w-12", req.method === "GET" && "text-[#4ec9b0]", req.method === "POST" && "text-[#ce9178]", req.method === "PUT" && "text-[#dcdcaa]", req.method === "DELETE" && "text-[#f14c4c]")}>{req.method}</span>
                            <span className="truncate flex-1 text-[#9cdcfe]">{(() => { try { return new URL(req.url).pathname; } catch { return req.url; } })()}</span>
                          </div>
                          <div className="text-[#6e6e6e] truncate text-[9px] mt-0.5">{(() => { try { return new URL(req.url).host; } catch { return ''; } })()}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {requests.filter(r => r.pending).length === 0 && pendingResponses.length === 0 && (
                    <div className="flex flex-col items-center justify-center p-8 text-[#6e6e6e] gap-2">
                      <Check size={24} className="opacity-20" />
                      <span>Queue is empty</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Sidebar Resize Handle */}
        {mainTab !== 'repeater' && (
          <div
            onMouseDown={startSidebarResize}
            className="w-1 bg-[#3c3c3c] hover:bg-[#007fd4] cursor-col-resize flex-shrink-0 flex items-center justify-center group"
            title="Drag to resize"
          >
            <GripVertical size={10} className="text-[#6e6e6e] group-hover:text-white opacity-0 group-hover:opacity-100" />
          </div>
        )}

        {/* Main Panel */}
        <div className="flex-1 flex flex-col">
          {mainTab === 'proxy' && proxyTab === 'match-replace' ? (
            <div className="flex-1 flex flex-col p-6 bg-[#1e1e1e] overflow-y-auto">
              {/* Rules Header */}
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-base font-bold text-[#e06c00] flex items-center gap-2 mb-1">
                    <Repeat size={18} /> HTTP match and replace rules
                  </h2>
                  <p className="text-[#888] text-[11px]">Use these settings to automatically replace parts of HTTP requests and responses passing through the Proxy.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveProject}
                    disabled={isSaving}
                    className="bg-[#007fd4] hover:bg-[#005a9e] text-white px-4 py-1.5 rounded text-xs flex items-center gap-2 font-bold shadow-sm disabled:opacity-50 min-w-[110px] justify-center"
                  >
                    {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                    {showSaveSuccess ? "Saved!" : "Save Rules"}
                  </button>
                  <button
                    onClick={() => setMatchReplaceRules(prev => [...prev, { enabled: true, item: 'Request header', match: '', replace: '', isRegex: false, comment: '' }])}
                    className="bg-[#2ea043] hover:bg-[#3fb950] text-white px-4 py-1.5 rounded text-xs flex items-center gap-2 font-bold shadow-sm"
                  >
                    <Plus size={16} /> Add Rule
                  </button>
                </div>
              </div>

              {/* Rules Table */}
              <div className="border border-[#3c3c3c] rounded shadow-lg overflow-hidden bg-[#252526]">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#333] text-[#bbb] border-b border-[#3c3c3c]">
                      <th className="px-3 py-2 text-left w-10">On</th>
                      <th className="px-3 py-2 text-left w-40">Item</th>
                      <th className="px-3 py-2 text-left">Match</th>
                      <th className="px-3 py-2 text-left">Replace</th>
                      <th className="px-3 py-2 text-left w-20">Regex</th>
                      <th className="px-3 py-2 text-left">Comment</th>
                      <th className="px-3 py-2 text-center w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#3c3c3c]">
                    {matchReplaceRules.map((rule, idx) => (
                      <tr key={idx} className="hover:bg-[#2d2d2d] group transition-colors">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={e => setMatchReplaceRules(prev => prev.map((r, i) => i === idx ? { ...r, enabled: e.target.checked } : r))}
                            className="accent-[#e06c00] w-3.5 h-3.5"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={rule.item}
                            onChange={e => setMatchReplaceRules(prev => prev.map((r, i) => i === idx ? { ...r, item: e.target.value } : r))}
                            className="bg-[#1e1e1e] text-[#d4d4d4] border border-transparent focus:border-[#007fd4] focus:ring-0 rounded-sm w-full py-0.5 px-1 outline-none"
                          >
                            <option value="Request header">Request header</option>
                            <option value="Response header">Response header</option>
                            <option value="Request body">Request body</option>
                            <option value="Response body">Response body</option>
                            <option value="Request first line">Request first line</option>
                            <option value="Response first line">Response first line</option>
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={rule.match}
                            onChange={e => setMatchReplaceRules(prev => prev.map((r, i) => i === idx ? { ...r, match: e.target.value } : r))}
                            placeholder="Match..."
                            className="bg-[#1e1e1e] text-[#d4d4d4] border border-transparent focus:border-[#007fd4] focus:ring-0 rounded-sm w-full py-0.5 px-1 outline-none placeholder:text-[#444]"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={rule.replace}
                            onChange={e => setMatchReplaceRules(prev => prev.map((r, i) => i === idx ? { ...r, replace: e.target.value } : r))}
                            placeholder="Replace with..."
                            className="bg-[#1e1e1e] text-[#d4d4d4] border border-transparent focus:border-[#007fd4] focus:ring-0 rounded-sm w-full py-0.5 px-1 outline-none placeholder:text-[#444]"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={rule.isRegex}
                            onChange={e => setMatchReplaceRules(prev => prev.map((r, i) => i === idx ? { ...r, isRegex: e.target.checked } : r))}
                            className="accent-[#3b82f6] w-3.5 h-3.5"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={rule.comment}
                            onChange={e => setMatchReplaceRules(prev => prev.map((r, i) => i === idx ? { ...r, comment: e.target.value } : r))}
                            placeholder="Rule name/comment"
                            className="bg-[#1e1e1e] text-[#d4d4d4] border border-transparent focus:border-[#007fd4] focus:ring-0 rounded-sm w-full py-0.5 px-1 outline-none placeholder:text-[#444]"
                          />
                        </td>
                        <td className="px-3 py-2 text-center text-[#555]">
                          <button
                            onClick={() => setMatchReplaceRules(prev => prev.filter((_, i) => i !== idx))}
                            className="hover:text-[#f85149] transition-colors p-1"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {matchReplaceRules.length === 0 && (
                  <div className="p-12 text-center text-[#6e6e6e] bg-[#2d2d2d]/20 flex flex-col items-center">
                    <History size={32} className="opacity-20 mb-3" />
                    <span className="italic">No match and replace rules defined yet.</span>
                    <button
                      onClick={() => setMatchReplaceRules([{ enabled: true, item: 'Request header', match: '', replace: '', isRegex: false, comment: '' }])}
                      className="mt-4 text-[#e06c00] hover:underline"
                    >
                      Click here to add your first rule
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-8 p-4 bg-[#1a2733] border border-[#3b82f6]/20 rounded-lg text-[11.5px] text-[#98c1fe] leading-relaxed">
                <p className="font-bold text-[#3b82f6] mb-2 uppercase tracking-wide text-[10px]">Technical Note:</p>
                <ul className="list-disc list-inside space-y-1 opacity-80">
                  <li>Rules are applied <strong>sequentially</strong> in the order they appear above.</li>
                  <li><strong>Header</strong> rules match the combined string `Name: Value`. Replacing with empty deletes it.</li>
                  <li><strong>Regex</strong> rules use standard Python regex syntax on the backend.</li>
                  <li><strong>First line</strong> rules allow changing the Method or URL (e.g. rewrite `GET /foo` to `POST /bar`).</li>
                </ul>
              </div>
            </div>
          ) : mainTab === 'repeater' ? (
            /* Repeater Toolbar */
            /* Repeater Toolbar & Tabs */
            <div className="flex flex-col border-b border-[#3c3c3c] bg-[#252526]">
              {/* Repeater Tabs */}
              <div className="flex bg-[#2d2d2d] overflow-x-auto no-scrollbar">
                {repeaterTabs.map(tab => (
                  <div
                    key={tab.id}
                    onClick={() => setActiveRepeaterTabId(tab.id)}
                    className={cn(
                      "group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-r border-[#3c3c3c] min-w-[80px]",
                      activeRepeaterTabId === tab.id ? "bg-[#1e1e1e] text-[#e06c00] border-t-2 border-t-[#e06c00]" : "text-[#888] hover:bg-[#333] hover:text-[#bbb]"
                    )}
                  >
                    <span className="truncate max-w-[100px]">{tab.name}</span>
                    <button
                      onClick={(e) => closeRepeaterTab(tab.id, e)}
                      className="opacity-0 group-hover:opacity-100 hover:text-[#da3633]"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={addRepeaterTab}
                  className="px-2 hover:bg-[#333] text-[#888] hover:text-white"
                  title="New Tab"
                >
                  <Plus size={12} />
                </button>
              </div>

              {/* Repeater Toolbar (Send/Cancel) */}
              <div className="h-10 flex items-center px-4 gap-3 bg-[#252526]">
                <button
                  onClick={sendRepeaterRequest}
                  disabled={repeaterTabs.find(t => t.id === activeRepeaterTabId)?.sending || !repeaterTabs.find(t => t.id === activeRepeaterTabId)?.request}
                  className={cn(
                    "px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2",
                    repeaterTabs.find(t => t.id === activeRepeaterTabId)?.sending || !repeaterTabs.find(t => t.id === activeRepeaterTabId)?.request
                      ? "bg-[#555] text-[#888] cursor-not-allowed"
                      : "bg-[#e06c00] hover:bg-[#ff8c00] text-white"
                  )}
                >
                  <Send size={14} /> {repeaterTabs.find(t => t.id === activeRepeaterTabId)?.sending ? "Sending..." : "Send"}
                </button>

                {repeaterTabs.find(t => t.id === activeRepeaterTabId)?.sending && (
                  <button
                    onClick={cancelRepeaterRequest}
                    className="px-3 py-1.5 rounded text-xs font-bold flex items-center gap-2 bg-[#da3633] hover:bg-[#f85149] text-white"
                  >
                    <X size={14} /> Cancel
                  </button>
                )}

                <div className="flex-1"></div>
                <div className="text-xs text-[#888] font-mono">
                  Manual Request Testing
                </div>
              </div>
            </div>
          ) : mainTab === 'proxy' && proxyTab === 'intercept' ? (
            /* Intercept Toolbar */
            <div className="h-10 border-b border-[#3c3c3c] flex items-center px-4 gap-3 bg-[#252526]">
              {/* Intercept Toggle */}
              <button
                onClick={toggleInterceptRequests}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-bold flex items-center gap-2 border transition-all",
                  interceptRequests
                    ? "bg-[#e06c00] border-[#ff8c00] text-white shadow-[0_0_10px_rgba(224,108,0,0.3)]"
                    : "bg-[#2d2d2d] border-[#555] text-[#888] hover:border-[#888] hover:text-[#bbb]"
                )}
                title="Intercept requests"
              >
                <div className={cn("w-2 h-2 rounded-full", interceptRequests ? "bg-white animate-pulse" : "bg-[#555]")}></div>
                Intercept is {interceptRequests ? "ON" : "OFF"}
              </button>

              <div className="w-px h-6 bg-[#3c3c3c]"></div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const pendingReqs = requests.filter(r => r.pending).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
                    if (selectedReqId && requests.find(r => r.id === selectedReqId)?.pending) {
                      // Parse rawRequest to send edited version
                      try {
                        const parsed = parseRawRequest(rawRequest);
                        forwardPendingRequest(selectedReqId, { method: parsed.method, headers: parsed.headers, body: parsed.body });
                      } catch (e) {
                        console.error("Failed to parse request, forwarding original", e);
                        forwardPendingRequest(selectedReqId);
                      }
                    } else if (selectedPendingResId) {
                      // Parse rawResponse to send edited version
                      try {
                        const parts = rawResponse.split('\r\n\r\n');
                        const headerLines = parts[0].split('\r\n');
                        const statusLine = headerLines[0];
                        const statusCode = parseInt(statusLine.split(' ')[1] || '200');
                        const headers: Record<string, string> = {};
                        headerLines.slice(1).forEach(line => {
                          const idx = line.indexOf(': ');
                          if (idx !== -1) {
                            headers[line.substring(0, idx)] = line.substring(idx + 2);
                          }
                        });
                        forwardPendingResponse(selectedPendingResId, { status: statusCode, headers, body: parts.slice(1).join('\r\n\r\n') });
                      } catch (e) {
                        console.error("Failed to parse response, forwarding original", e);
                        forwardPendingResponse(selectedPendingResId);
                      }
                    } else if (pendingReqs.length > 0) {
                      forwardPendingRequest(pendingReqs[0].id);
                    } else if (pendingResponses.length > 0) {
                      forwardPendingResponse(pendingResponses[0].id);
                    }
                  }}
                  disabled={!((selectedReqId && requests.find(r => r.id === selectedReqId)?.pending) || selectedPendingResId || requests.some(r => r.pending) || pendingResponses.length > 0)}
                  className="px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 bg-[#2ea043] hover:bg-[#3fb950] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play size={14} fill="currentColor" /> Forward
                </button>
                <button
                  onClick={() => {
                    if (selectedReqId && requests.find(r => r.id === selectedReqId)?.pending) {
                      dropPendingRequest(selectedReqId);
                    } else if (selectedPendingResId) {
                      dropPendingResponse(selectedPendingResId);
                    } else {
                      const pendingReqs = requests.filter(r => r.pending).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
                      if (pendingReqs.length > 0) dropPendingRequest(pendingReqs[0].id);
                      else if (pendingResponses.length > 0) dropPendingResponse(pendingResponses[0].id);
                    }
                  }}
                  disabled={!((selectedReqId && requests.find(r => r.id === selectedReqId)?.pending) || selectedPendingResId || requests.some(r => r.pending) || pendingResponses.length > 0)}
                  className="px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 bg-[#da3633] hover:bg-[#f85149] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <X size={14} /> Drop
                </button>
              </div>

              <div className="flex-1"></div>
              <div className="text-xs text-[#888] font-mono">
                {selectedReqId && requests.find(r => r.id === selectedReqId)?.pending ? "Editing Request" :
                  selectedPendingResId ? "Editing Response" :
                    (requests.some(r => r.pending) || pendingResponses.length > 0) ? "Pending items in queue" : "Interception paused / Queue empty"}
              </div>
            </div>
          ) : (
            /* History View Header (Fallthrough if proxyTab is history) */
            <div className="h-10 border-b border-[#3c3c3c] flex items-center px-4 gap-2 bg-[#2d2d2d]">
              <span className="font-bold text-[#3b82f6] flex items-center gap-2">
                <History size={14} /> History (Read-only)
              </span>
              <div className="flex-1"></div>
              <div className="text-[10px] text-[#6e6e6e]">{selectedReqId ? "Right-click to send to Repeater" : "Select a request"}</div>
            </div>
          )}

          {!(mainTab === 'proxy' && proxyTab === 'match-replace') && (
            <div className="flex-1 flex overflow-hidden" data-panel-area>
              <div style={{ width: `${requestPanelWidth}%` }} className="flex flex-col border-r border-[#3c3c3c] flex-shrink-0">
                <div className="h-6 bg-[#2d2d2d] border-b border-[#3c3c3c] flex items-center px-2">
                  <span className="text-[10px] font-bold text-[#e06c00]">Request</span>
                </div>
                {mainTab === 'repeater' ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    <HighlightedTextarea
                      value={repeaterTabs.find(t => t.id === activeRepeaterTabId)?.request || ''}
                      onChange={e => setRepeaterTabs(prev => prev.map(t => t.id === activeRepeaterTabId ? { ...t, request: e.target.value } : t))}
                      placeholder="Request (Headers then Body)"
                    />
                  </div>
                ) : (
                  <textarea
                    className="flex-1 bg-[#1e1e1e] p-2 text-[#9cdcfe] focus:outline-none resize-none font-mono text-xs leading-relaxed"
                    value={rawRequest}
                    onChange={e => setRawRequest(e.target.value)}
                    onContextMenu={e => {
                      if (mainTab === 'proxy' && selectedReqId) {
                        const req = requests.find(r => r.id === selectedReqId);
                        if (req) {
                          e.preventDefault();
                          setContextMenu({ x: e.clientX, y: e.clientY, reqUrl: req.url, reqId: req.id, isPending: !!req.pending });
                        }
                      }
                    }}
                    readOnly={mainTab === 'proxy' && (proxyTab === 'history' || (proxyTab === 'intercept' && !(selectedReqId && requests.find(r => r.id === selectedReqId)?.pending)))}
                    placeholder="Select a request to view details"
                    spellCheck={false}
                  />
                )}
              </div>

              {/* Panel Resize Handle */}
              <div
                onMouseDown={startPanelResize}
                className="w-1 bg-[#3c3c3c] hover:bg-[#007fd4] cursor-col-resize flex-shrink-0 flex items-center justify-center group"
                title="Drag to resize"
              >
                <GripVertical size={10} className="text-[#6e6e6e] group-hover:text-white opacity-0 group-hover:opacity-100" />
              </div>

              <div className="flex-1 flex flex-col min-w-[200px]">
                <div className="h-6 bg-[#2d2d2d] border-b border-[#3c3c3c] flex items-center px-2">
                  <span className="text-[10px] font-bold text-[#4ec9b0]">Response</span>
                </div>
                {mainTab === 'repeater' ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    <HighlightedTextarea
                      value={repeaterTabs.find(t => t.id === activeRepeaterTabId)?.response || ''}
                      readOnly
                      placeholder="Response (Headers then Body)"
                    />
                  </div>
                ) : (
                  <textarea
                    className="flex-1 bg-[#1e1e1e] p-2 text-[#ce9178] focus:outline-none resize-none font-mono text-xs leading-relaxed"
                    value={rawResponse}
                    onChange={e => {
                      if (mainTab === 'proxy' && proxyTab === 'intercept' && selectedPendingResId) setRawResponse(e.target.value);
                    }}
                    onContextMenu={e => {
                      if (mainTab === 'proxy' && selectedReqId) {
                        const req = requests.find(r => r.id === selectedReqId);
                        if (req) {
                          e.preventDefault();
                          setContextMenu({ x: e.clientX, y: e.clientY, reqUrl: req.url, reqId: req.id, isPending: !!req.pending });
                        }
                      }
                    }}
                    readOnly={!(mainTab === 'proxy' && proxyTab === 'intercept' && selectedPendingResId)}
                    placeholder="Response body will appear here"
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="h-5 bg-[#007fd4] flex items-center px-2 text-[10px] text-white">
        <span>{requests.length} requests captured</span>
        <div className="flex-1"></div>
        {/* Restored Save Project Button into Status Bar for compactness, or check replacement strategy */}

        {/* Actually, inserting into the Top Bar using chunk 4 */}
        <span>Project: {projectName}</span>
      </div>
    </div >
  );
}

export default App;
