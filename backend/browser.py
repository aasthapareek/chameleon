import asyncio
import json
import logging
import subprocess
import sys
import os
import uuid
import time
from typing import Callable, Dict, Optional, Any
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Request, Response

logger = logging.getLogger(__name__)

def ensure_browser_installed():
    """Check if Playwright browser is installed, download if not."""
    print("=" * 50)
    print("Chameleon - Initializing...")
    print("=" * 50)
    
    # Standard browser location
    home = os.path.expanduser("~")
    ms_pw_path = os.path.join(home, "AppData", "Local", "ms-playwright")
    
    # Set the browser path environment variable
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = ms_pw_path
    
    # Check if browser exists
    browser_exists = False
    if os.path.exists(ms_pw_path):
        for d in os.listdir(ms_pw_path):
            if 'chromium' in d.lower() and os.path.isdir(os.path.join(ms_pw_path, d)):
                chromium_path = os.path.join(ms_pw_path, d)
                # Check if chrome.exe exists
                for root, dirs, files in os.walk(chromium_path):
                    if 'chrome.exe' in files:
                        browser_exists = True
                        print(f"[OK] Browser found at: {chromium_path}")
                        break
                if browser_exists:
                    break
    
    if browser_exists:
        print()
        return
    
    print("[!] Browser not found. Downloading Chromium...")
    print("    This is a one-time download (~150MB), please wait...")
    print()
    
    try:
        # Use npx playwright or find playwright executable
        # First try using the playwright package directly
        from playwright._impl._driver import compute_driver_executable
        driver_path = compute_driver_executable()
        cli_path = os.path.join(os.path.dirname(driver_path), "package", "cli.js")
        
        if os.path.exists(driver_path):
            result = subprocess.run(
                [driver_path, "install", "chromium"],
                capture_output=False,
                env={**os.environ, "PLAYWRIGHT_BROWSERS_PATH": ms_pw_path}
            )
            if result.returncode == 0:
                print()
                print("[OK] Browser download complete!")
            else:
                print("[!] Browser download may have issues...")
        else:
            # Fallback: try npx
            subprocess.run(
                ["npx", "playwright", "install", "chromium"],
                capture_output=False,
                shell=True,
                env={**os.environ, "PLAYWRIGHT_BROWSERS_PATH": ms_pw_path}
            )
    except Exception as e:
        print(f"[!] Error: {e}")
        print("    Please run manually: npx playwright install chromium")
    
    print()

# Auto-download browser on import
ensure_browser_installed()

class BrowserManager:
    def __init__(self, on_request_captured: Callable[[Dict], None]):
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.on_request_captured = on_request_captured
        self.active = False
        
        # Interception state
        self.intercept_requests = False
        self.intercept_responses = False
        self.pending_items: Dict[str, Dict[str, Any]] = {}  # id -> {route, request, event, type}
        self.match_replace_rules: List[Any] = []

    async def start(self, url: str):
        if self.active:
            await self.stop()
        
        try:
            print(f"[Browser] Starting Playwright...")
            self.playwright = await async_playwright().start()
            
            print(f"[Browser] Launching Chromium...")
            # Launch persistent context or regular launch? Regular for now.
            # We use a real chrome user agent if possible or just let playwright handle it.
            # To better bypass fingerprinting, we rely on the fact that it IS a real browser.
            self.browser = await self.playwright.chromium.launch(
                headless=False, 
                args=[
                    "--disable-blink-features=AutomationControlled", 
                    "--start-maximized",
                    "--window-position=0,0",
                    "--window-size=1920,1080"
                ] 
            )
            print(f"[Browser] Chromium launched successfully!")
        except Exception as e:
            print(f"[Browser] ERROR launching browser: {e}")
            print(f"[Browser] You may need to run: playwright install chromium")
            logger.error(f"Failed to launch browser: {e}")
            raise
        
        # User Agent override can help, but default chromium one is usually okay.
        # We'll use a standard context.
        # Setting viewport to None allows the page to resize to the window size
        self.context = await self.browser.new_context(
            viewport=None,
            ignore_https_errors=True 
        )
        
        # Use route interception for requests (allows pause/modify/forward)
        await self.context.route("**/*", self._route_handler)
        
        # Response listener (for capturing, intercept handled in route)


        self.page = await self.context.new_page()
        self.active = True

        try:
            await self.page.goto(url, wait_until="domcontentloaded")
        except Exception as e:
            logger.error(f"Error navigating to {url}: {e}")

    def _apply_match_replace(self, item_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply match and replace rules to the given data.
        item_type: 'Request header', 'Response header', 'Request body', 'Response body', 'Request first line', 'Response first line'
        data: depends on item_type
        """
        import re
        
        rules = [r for r in self.match_replace_rules if r.enabled and r.item == item_type]
        if not rules:
            return data

        if item_type in ['Request header', 'Response header']:
            # data is a dict of headers
            headers = data.copy()
            for rule in rules:
                # In Burp, header matching can match the entire header line or just the value.
                # Here we'll treat it as: if match is 'HeaderName: .*', replace it.
                # Or if match is just 'HeaderName', replace the whole line?
                # Actually, Burp's 'Request header' rule usually matches the header string 'Name: Value'.
                
                # Simple implementation: iterate over all headers, join as string, replace, split back.
                # This is most flexible for replacing parts of values or deleting headers.
                header_lines = [f"{k}: {v}" for k, v in headers.items()]
                new_lines = []
                for line in header_lines:
                    new_line = line
                    if rule.isRegex:
                        try:
                            new_line = re.sub(rule.match, rule.replace, line)
                        except: pass
                    else:
                        new_line = line.replace(rule.match, rule.replace)
                    
                    if new_line: # If empty after replace, effectively deletes the header
                         new_lines.append(new_line)
                
                # Re-parse headers
                new_headers = {}
                for line in new_lines:
                    if ': ' in line:
                        k, v = line.split(': ', 1)
                        new_headers[k] = v
                    elif ':' in line:
                        k, v = line.split(':', 1)
                        new_headers[k] = v
                headers = new_headers
            return headers

        elif item_type in ['Request body', 'Response body']:
            # data is a string
            body = data
            if body is None: return body
            for rule in rules:
                if rule.isRegex:
                    try:
                        body = re.sub(rule.match, rule.replace, body)
                    except: pass
                else:
                    body = body.replace(rule.match, rule.replace)
            return body

        elif item_type == 'Request first line':
            # data: {method, url}
            line = f"{data['method']} {data['url']} HTTP/1.1" # Simplified line
            for rule in rules:
                if rule.isRegex:
                    try:
                        line = re.sub(rule.match, rule.replace, line)
                    except: pass
                else:
                    line = line.replace(rule.match, rule.replace)
            
            # Try to reconstruct method/url
            parts = line.split(' ')
            if len(parts) >= 2:
                return {"method": parts[0], "url": parts[1]}
            return data

        elif item_type == 'Response first line':
            # data: {status}
            line = f"HTTP/1.1 {data['status']}"
            for rule in rules:
                if rule.isRegex:
                    try:
                        line = re.sub(rule.match, rule.replace, line)
                    except: pass
                else:
                    line = line.replace(rule.match, rule.replace)
            
            # Try to reconstruct status
            parts = line.split(' ')
            if len(parts) >= 2:
                try:
                    return {"status": int(parts[1])}
                except: pass
            return data

        return data

    async def _route_handler(self, route):
        """Handle route interception - can pause for user decision on request AND response"""
        request = route.request
        
        try:
            # Prepare Request Data
            headers = await request.all_headers()
            post_data = request.post_data
            
            # --- Apply Match & Replace (Request) ---
            # 1. First Line
            line_data = self._apply_match_replace('Request first line', {"method": request.method, "url": request.url})
            final_method = line_data.get("method", request.method)
            final_url = line_data.get("url", request.url)
            
            # 2. Headers
            final_headers = self._apply_match_replace('Request header', headers)
            
            # 3. Body
            final_body = self._apply_match_replace('Request body', post_data)
            
            req_id = str(uuid.uuid4())
            req_data = {
                "id": req_id,
                "type": "request",
                "method": final_method,
                "url": final_url,
                "headers": final_headers,
                "body": final_body,
                "resourceType": request.resource_type,
                "timestamp": time.time() * 1000,
                "pending": self.intercept_requests
            }
            
            # 1. Capture/Intercept Request
            # (We use the modified values from here on)
            
            # Check for Repeater Bypass Header (case-insensitive)
            # And Header Overrides (to support forbidden headers like Host/Cookie/UA in Repeater)
            is_repeater_bypass = False
            override_headers = {}
            
            for k, v in list(final_headers.items()): # list to avoid runtime change issues
                kl = k.lower()
                if kl == "x-waf-bypass-repeater":
                    is_repeater_bypass = True
                elif kl == "x-antigravity-override":
                    try:
                        override_headers = json.loads(v)
                    except:
                        pass
            
            # Remove internal headers and Apply Overrides
            if is_repeater_bypass or override_headers:
                # Start with original headers (already modified by match/replace), remove internal ones
                final_headers = {k: v for k, v in final_headers.items() 
                                 if k.lower() not in ["x-waf-bypass-repeater", "x-antigravity-override"]}
                # Apply overrides (Host, Cookie, UA, etc.)
                if override_headers:
                    final_headers.update(override_headers)

            if self.intercept_requests and not is_repeater_bypass:
                event = asyncio.Event()
                self.pending_items[req_id] = {
                    "route": route,
                    "request": request,
                    "event": event,
                    "type": "request",
                    "data": req_data
                }
                
                if self.on_request_captured:
                    await self.on_request_captured(req_data)
                
                # Wait for user action
                await event.wait()
                
                item = self.pending_items.get(req_id)
                if item and item.get("action") == "drop":
                    if req_id in self.pending_items:
                        del self.pending_items[req_id]
                    await route.abort()
                    return
                
                # Apply further modifications from manual Intercept UI
                modified = item.get("modified", {}) if item else {}
                final_method = modified.get("method", final_method)
                final_headers = modified.get("headers", final_headers)
                final_body = modified.get("body", final_body)
                
                if req_id in self.pending_items:
                    del self.pending_items[req_id]
            else:
                 # Just capture
                if self.on_request_captured:
                    await self.on_request_captured(req_data)

            # 2. Fetch Response (Always fetch to capture it reliably)
            # EXCEPTION: If Repeater Bypass is active, use route.continue_ to preserve browser TLS fingerprint
            if is_repeater_bypass:
                try:
                    # Clean headers for continue_
                    continue_headers = {k: v for k, v in final_headers.items() if k.lower() not in ["host", "content-length"]}
                    
                    await route.continue_(
                        method=final_method,
                        url=final_url,
                        headers=continue_headers,
                        post_data=final_body
                    )
                except Exception as e:
                    logger.error(f"Continue failed: {e}")
                    await route.abort()
                return

            try:
                response = await route.fetch(
                    method=final_method,
                    url=final_url,
                    headers=final_headers,
                    post_data=final_body
                )
            except Exception as e:
                logger.error(f"Fetch failed: {e}")
                await route.abort()
                return

            # 3. Capture/Intercept Response
            res_id = str(uuid.uuid4())
            
            # Get body
            try:
                res_body = await response.text()
            except:
                res_body = "<binary data>"
                
            res_headers = response.headers
            res_status = response.status
            
            # --- Apply Match & Replace (Response) ---
            # 1. First Line
            line_data = self._apply_match_replace('Response first line', {"status": res_status})
            res_status = line_data.get("status", res_status)
            
            # 2. Headers
            res_headers = self._apply_match_replace('Response header', res_headers)
            
            # 3. Body
            res_body = self._apply_match_replace('Response body', res_body)
            
            res_data = {
                "id": res_id,
                "req_id": req_id, # LINKING ID!
                "type": "response",
                "url": response.url,
                "status": res_status,
                "headers": res_headers,
                "body": res_body,
                "pending": self.intercept_responses,
                "timestamp": time.time() * 1000
            }
            
            if self.intercept_responses:
                event = asyncio.Event()
                self.pending_items[res_id] = {
                    "route": route,
                    "response": response, # Original APIResponse
                    "event": event,
                    "type": "response",
                    "data": res_data
                }
                
                if self.on_request_captured:
                    await self.on_request_captured(res_data)
                
                await event.wait()
                
                item = self.pending_items.get(res_id)
                if item and item.get("action") == "drop":
                    if res_id in self.pending_items:
                        del self.pending_items[res_id]
                    # We can't really 'drop' a response in route.fulfill() easily other than aborting navigation
                    # or returning empty? Aborting is safest.
                    await route.abort()
                    return
                
                # Apply modifications
                modified = item.get("modified", {}) if item else {}
                res_status = modified.get("status", res_status)
                res_headers = modified.get("headers", res_headers)
                res_body = modified.get("body", res_body)
                
                if res_id in self.pending_items:
                    del self.pending_items[res_id]

            else:
                if self.on_request_captured:
                    await self.on_request_captured(res_data)

            # 4. Fulfill the route
            # If body is modified, we need to pass string/bytes. If not, we can pass response?
            # fulfill(response=response) uses original.
            # We want to support modification.
            
            await route.fulfill(
                status=res_status,
                headers=res_headers,
                body=res_body
            )

        except Exception as e:
            logger.error(f"Error in route handler: {e}")
            try:
                await route.continue_() # Fallback
            except:
                pass

    def set_intercept_requests(self, enabled: bool):
        """Toggle request interception"""
        self.intercept_requests = enabled
        logger.info(f"Request interception: {'ON' if enabled else 'OFF'}")

    def set_intercept_responses(self, enabled: bool):
        """Toggle response interception"""
        self.intercept_responses = enabled
        logger.info(f"Response interception: {'ON' if enabled else 'OFF'}")

    def forward_item(self, item_id: str, modified_data: Optional[Dict] = None):
        """Forward a pending request/response"""
        if item_id in self.pending_items:
            item = self.pending_items[item_id]
            item["action"] = "forward"
            if modified_data:
                item["modified"] = modified_data
            item["event"].set()
            return True
        return False

    def drop_item(self, item_id: str):
        """Drop a pending request/response"""
        if item_id in self.pending_items:
            item = self.pending_items[item_id]
            item["action"] = "drop"
            item["event"].set()
            return True
        return False

    async def stop(self):
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        self.active = False

    async def replay_request(self, request_data: Dict):
        """
        Replay a request using the open browser context.
        This bypasses WAFs because it originates from the valid browser executable.
        """
        if not self.page:
            raise Exception("Browser not active")

        method = request_data.get("method", "GET")
        url = request_data.get("url")
        headers = request_data.get("headers", {})
        body = request_data.get("body", None)

        # Remove some headers that the browser sets automatically or cause issues
        # Content-Length is usually auto-calced. Host is auto-set.
        # Cookies should be handled by the browser context mostly, 
        # BUT if the user wants to spoof a specific cookie, we might need to set it in the context first
        # or pass it in headers if fetch allows.
        
        # 'page.evaluate' with 'fetch' is usually the most "browser-like" way to send a request.
        # However, cookies in 'headers' of fetch might be overridden by document cookies.
        
        # Strategy: Use page.evaluate to run window.fetch
        # This is the ULTIMATE WAF bypass because it IS the browser's JS engine sending it.
        
        try:
            # 0. Navigate to the target domain first!
            # WAFs like Incapsula check if window.location matches the request domain.
            # Running from about:blank triggers immediate blocks.
            from urllib.parse import urlparse
            target_url_obj = urlparse(url)
            target_origin = f"{target_url_obj.scheme}://{target_url_obj.netloc}"
            
            # Only navigate if we are not already there (to save time)
            if not self.page.url.startswith(target_origin):
                logger.info(f"Navigating to {target_origin} to establish correct Origin/Context...")
                try:
                    # We just need to establish the Origin. 
                    # 'commit' is enough to set window.location. We don't need full load.
                    await self.page.goto(target_origin, wait_until="commit", timeout=10000)
                except Exception as e:
                    logger.warning(f"Navigation to {target_origin} failed/timed out, proceeding anyway: {e}")

            # Prepare Header Overrides (Ultimate Bypass)
            # Browser fetch API blocks many headers (unsafe). We pack them into a custom header
            # which _route_handler will unpack and apply to the final request.
            import json
            headers_json = json.dumps(headers)

            # Filter for SAFE headers only for the JS fetch call
            # This list includes headers typically forbidden in window.fetch
            forbidden = ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie", "user-agent", "referer", "origin", "content-length", "date", "expect"]
            
            safe_headers = {k: v for k, v in headers.items() if k.lower() not in forbidden and not k.lower().startswith("sec-")}

            # Inject Control Headers
            safe_headers["X-WAF-Bypass-Repeater"] = "1"
            safe_headers["X-Antigravity-Override"] = headers_json

            # Use page.evaluate to run window.fetch inside the browser context
            # We use strict response listening via Playwright to verify we got the response
            # independent of whether JS can read the body (CORS/Opaque)
            # Use page.evaluate to run window.fetch AND return the data directly
            # This avoids "No resource with given identifier" Protocol Errors from CDP
            # because we are reading the body inside the JS VM immediately.
            js_script = """
            async ({url, method, headers, body}) => {
                const options = {
                    method: method,
                    headers: headers,
                };
                if (method !== 'GET' && method !== 'HEAD') {
                    options.body = body;
                }
                
                try {
                    const response = await fetch(url, options);
                    const text = await response.text();
                    
                    // Convert headers to simple object
                    const respHeaders = {};
                    response.headers.forEach((value, key) => {
                        respHeaders[key] = value;
                    });

                    return {
                        status: response.status,
                        headers: respHeaders,
                        body: text
                    };
                } catch (e) {
                    return { error: e.toString() };
                }
            }
            """
            
            try:
                # We don't need expect_response anymore, evaluate will wait for the fetch
                result = await self.page.evaluate(js_script, {
                    "url": url,
                    "method": method,
                    "headers": safe_headers,
                    "body": body
                })
                
                if "error" in result:
                     return {"error": f"JS Fetch Error: {result['error']}"}

                return {
                    "status": result["status"],
                    "headers": result["headers"],
                    "body": result["body"]
                }
            except asyncio.TimeoutError:
                logger.error(f"Replay timed out for {url}")
                return {"error": "Request timed out (30s)."}
            except asyncio.TimeoutError:
                logger.error(f"Replay timed out for {url}")
                return {"error": "Request timed out (30s). The server took too long to respond."}

        except Exception as e:
            logger.error(f"Replay failed: {e}")
            return {"error": str(e)}
