# Browser Automation Spec

Implementation-ready specification for browser automation in Sandbox Agent. Covers the HTTP API, CLI install command, TypeScript SDK surface, inspector UI tab, and Rust module structure.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [CLI: `install browser`](#2-cli-install-browser)
3. [HTTP API: `/v1/browser/*`](#3-http-api-v1browser)
4. [Rust Module Structure](#4-rust-module-structure)
5. [TypeScript SDK](#5-typescript-sdk)
6. [Inspector UI: Browser Tab](#6-inspector-ui-browser-tab)
7. [React Component: `BrowserViewer`](#7-react-component-browserviewer)
8. [Desktop Integration](#8-desktop-integration)
9. [Error Handling](#9-error-handling)
10. [Testing](#10-testing)

---

## 1. Architecture Overview

Browser automation reuses the existing desktop infrastructure (Xvfb + Neko) in a minimal mode where Chromium is the only application. No window manager is needed.

```
┌─────────────────────────────────────────────────┐
│  Sandbox                                         │
│                                                  │
│  ┌────────┐   ┌──────────────┐   ┌───────────┐  │
│  │  Neko  │←──│  Chromium     │──→│ CDP Server│  │
│  │(WebRTC)│   │  (on Xvfb)   │   │  (:9222)  │  │
│  └───┬────┘   └──────────────┘   └─────┬─────┘  │
│      │ stream                          │ CDP     │
└──────┼─────────────────────────────────┼─────────┘
       │                                 │
  WebRTC (UDP)                    WebSocket / REST
       │                                 │
┌──────┴─────────────────────────────────┴─────────┐
│              Sandbox Agent HTTP API               │
│                                                   │
│  /v1/browser/*  (REST convenience wrappers)       │
│  /v1/browser/cdp (WebSocket proxy to :9222)       │
│  /v1/desktop/stream/signaling (Neko WebRTC)       │
│  /v1/desktop/screenshot (shared with desktop)     │
│  /v1/desktop/recording/* (shared with desktop)    │
└───────────────────────────────────────────────────┘
```

### Key decisions

- **Minimal mode**: Chromium runs directly on Xvfb. No Openbox window manager. Chromium starts in `--kiosk` or `--start-maximized` mode, filling the entire virtual display.
- **Neko reuse**: The existing `DesktopStreamingManager` streams the Xvfb framebuffer. No changes needed; Chromium renders to the same display Neko captures.
- **CDP proxy**: Sandbox Agent proxies WebSocket connections to Chromium's CDP server on localhost:9222. This lets external Playwright/Puppeteer clients connect through the Sandbox Agent URL without exposing the raw CDP port.
- **REST convenience endpoints**: Thin wrappers around CDP calls for common operations (navigate, screenshot, content extraction). These call Chromium's CDP internally via a persistent connection.
- **Shared desktop infrastructure**: Screenshots, recordings, streaming, and mouse/keyboard input all reuse existing desktop endpoints. The browser API adds browser-specific operations on top.

---

## 2. CLI: `install browser`

### Command

```bash
sandbox-agent install browser [--yes] [--print-only] [--package-manager <apt|dnf|apk>]
```

### Implementation

New file: `server/packages/sandbox-agent/src/browser_install.rs`

Follow the exact pattern of `desktop_install.rs`:

```rust
#[derive(Debug, Clone)]
pub struct BrowserInstallRequest {
    pub yes: bool,
    pub print_only: bool,
    pub package_manager: Option<DesktopPackageManager>,  // reuse from desktop_install
}

pub fn install_browser(request: BrowserInstallRequest) -> Result<(), String> {
    // 1. Platform check (Linux only)
    // 2. Detect or validate package manager (reuse detect_package_manager)
    // 3. Build package list
    // 4. Privilege check (root or sudo)
    // 5. Display packages + confirm
    // 6. Run install commands
}
```

### Packages by distro

**APT (Debian/Ubuntu):**
```
chromium
chromium-sandbox
libnss3
libatk-bridge2.0-0
libdrm2
libxcomposite1
libxdamage1
libxrandr2
libgbm1
libasound2
libpangocairo-1.0-0
libgtk-3-0
```

**DNF (Fedora/RHEL):**
```
chromium
```

**APK (Alpine):**
```
chromium
nss
```

### CLI registration

In `cli.rs`, add to the `InstallCommand` enum:

```rust
#[derive(Subcommand, Debug)]
pub enum InstallCommand {
    /// Install desktop runtime dependencies.
    Desktop(InstallDesktopArgs),
    /// Install browser automation dependencies (Chromium).
    Browser(InstallBrowserArgs),
}

#[derive(Args, Debug)]
pub struct InstallBrowserArgs {
    #[arg(long, default_value_t = false)]
    yes: bool,
    #[arg(long, default_value_t = false)]
    print_only: bool,
    #[arg(long, value_enum)]
    package_manager: Option<DesktopPackageManager>,
}
```

### Dependency detection

Add `detect_missing_browser_dependencies()` to check for:
- `chromium` or `chromium-browser` binary in PATH
- Desktop dependencies (Xvfb, xdotool, etc.) since browser mode requires them

Return helpful install suggestion:
```
"sandbox-agent install browser --yes"
```

If desktop deps are also missing, suggest:
```
"sandbox-agent install desktop --yes && sandbox-agent install browser --yes"
```

Or consider having `install browser` also install desktop deps automatically (since browser mode requires Xvfb).

---

## 3. HTTP API: `/v1/browser/*`

All endpoints return `application/json` unless otherwise noted. Error responses use `application/problem+json` (same as desktop API).

### 3.1 Lifecycle

#### `POST /v1/browser/start`

Start the browser runtime: Xvfb + Chromium + Neko streaming.

**Request body:**
```typescript
{
  // Display
  width?: number,          // default: 1280
  height?: number,         // default: 720
  dpi?: number,            // default: 96

  // Browser
  url?: string,            // initial URL to navigate to (default: "about:blank")
  headless?: boolean,      // if true, skip Neko (no streaming). default: false

  // Streaming (same as desktop)
  streamVideoCodec?: string,    // "vp8" | "vp9" | "h264", default: "vp8"
  streamAudioCodec?: string,    // "opus" | "g722", default: "opus"
  streamFrameRate?: number,     // 1-60, default: 30
  webrtcPortRange?: string,     // default: "59050-59070"
  recordingFps?: number,        // default: 30
}
```

**Response (200):**
```typescript
{
  state: "active" | "starting" | "inactive" | "install_required" | "failed",
  display?: string,           // ":99"
  resolution?: { width: number, height: number, dpi?: number },
  startedAt?: string,         // ISO 8601
  cdpUrl?: string,            // "ws://127.0.0.1:9222/devtools/browser/..."
  url?: string,               // current page URL
  missingDependencies: string[],
  installCommand?: string,
  processes: Array<{ name: string, pid?: number, running: boolean }>,
  lastError?: { code: string, message: string },
}
```

**Internal sequence:**
1. Check for missing dependencies (Xvfb, chromium, neko)
2. Start Xvfb on chosen display (reuse `start_xvfb_locked`)
3. Wait for X11 socket
4. Start Chromium:
   ```bash
   chromium \
     --no-sandbox \
     --disable-gpu \
     --disable-dev-shm-usage \
     --remote-debugging-port=9222 \
     --remote-debugging-address=127.0.0.1 \
     --start-maximized \
     --window-size=WIDTH,HEIGHT \
     --window-position=0,0 \
     --no-first-run \
     --no-default-browser-check \
     --disable-infobars \
     --disable-background-networking \
     --disable-sync \
     --disable-translate \
     --disable-extensions \
     --user-data-dir=/tmp/chromium-profile \
     [URL]
   ```
5. Poll CDP endpoint `http://127.0.0.1:9222/json/version` until ready (15s timeout)
6. If not headless: start Neko streaming (reuse `DesktopStreamingManager.start()`)
7. Return status

#### `POST /v1/browser/stop`

Stop browser, Neko, and Xvfb.

**Response (200):**
```typescript
{ state: "inactive" }
```

#### `GET /v1/browser/status`

**Response (200):** Same shape as start response.

### 3.2 CDP Access

#### `GET /v1/browser/cdp`

WebSocket upgrade. Proxies the connection to Chromium's CDP server at `ws://127.0.0.1:9222/devtools/browser/{id}`.

This allows external Playwright/Puppeteer to connect:
```typescript
const browser = await chromium.connectOverCDP("ws://sandbox-host:2468/v1/browser/cdp");
```

**Implementation:** Bidirectional WebSocket relay (same pattern as the Neko signaling proxy in `router.rs:2817-2921`).

### 3.3 Navigation

#### `POST /v1/browser/navigate`

```typescript
// Request
{ url: string, waitUntil?: "load" | "domcontentloaded" | "networkidle" }

// Response (200)
{ url: string, title: string, status: number }
```

**CDP calls:** `Page.navigate` + `Page.lifecycleEvent` wait.

#### `POST /v1/browser/back`

```typescript
// Response (200)
{ url: string, title: string }
```

**CDP call:** `Page.navigateHistory` with delta -1.

#### `POST /v1/browser/forward`

```typescript
// Response (200)
{ url: string, title: string }
```

#### `POST /v1/browser/reload`

```typescript
// Request (optional)
{ ignoreCache?: boolean }

// Response (200)
{ url: string, title: string }
```

#### `POST /v1/browser/wait`

```typescript
// Request
{ selector?: string, timeout?: number, state?: "visible" | "hidden" | "attached" }

// Response (200)
{ found: boolean }
```

**CDP calls:** `Runtime.evaluate` with MutationObserver or `DOM.querySelector` polling.

### 3.4 Tab Management

#### `GET /v1/browser/tabs`

```typescript
// Response (200)
{
  tabs: Array<{
    id: string,          // CDP target ID
    url: string,
    title: string,
    active: boolean,     // true for the tab currently receiving input
  }>
}
```

**CDP call:** `Target.getTargets` filtered to `type: "page"`.

#### `POST /v1/browser/tabs`

Create a new tab.

```typescript
// Request
{ url?: string }

// Response (201)
{ id: string, url: string, title: string }
```

**CDP call:** `Target.createTarget`.

#### `POST /v1/browser/tabs/{id}/activate`

Switch to this tab (bring to foreground, receive input from Neko stream).

```typescript
// Response (200)
{ id: string, url: string, title: string }
```

**CDP call:** `Target.activateTarget`.

#### `DELETE /v1/browser/tabs/{id}`

Close a tab.

```typescript
// Response (200)
{ ok: true }
```

**CDP call:** `Target.closeTarget`.

### 3.5 Content Extraction

#### `GET /v1/browser/screenshot`

Screenshot of the current browser tab.

```typescript
// Query params
format?: "png" | "jpeg" | "webp"   // default: png
quality?: number                     // 0-100, for jpeg/webp
fullPage?: boolean                   // capture entire scrollable page
selector?: string                    // screenshot specific element

// Response: image binary with appropriate Content-Type
```

**CDP call:** `Page.captureScreenshot`. This is browser-level (just the viewport/page), distinct from `GET /v1/desktop/screenshot` which captures the entire Xvfb display.

#### `GET /v1/browser/pdf`

Generate PDF of current page.

```typescript
// Query params
format?: "a4" | "letter" | "legal"
landscape?: boolean
printBackground?: boolean
scale?: number

// Response: application/pdf binary
```

**CDP call:** `Page.printToPDF`.

#### `GET /v1/browser/content`

Get page HTML.

```typescript
// Query params
selector?: string    // if provided, return innerHTML of matching element

// Response (200)
{ html: string, url: string, title: string }
```

**CDP call:** `Runtime.evaluate` with `document.documentElement.outerHTML` or element query.

#### `GET /v1/browser/markdown`

Get page content as markdown.

```typescript
// Response (200)
{ markdown: string, url: string, title: string }
```

**Implementation:** Extract DOM via CDP, convert to markdown using a Rust markdown conversion library (e.g., `html2md` crate). Strip nav/footer/aside elements before conversion for cleaner output.

#### `POST /v1/browser/scrape`

Extract elements matching CSS selectors.

```typescript
// Request
{
  selectors: Record<string, string>,   // { "title": "h1", "price": ".price" }
  url?: string                          // optionally navigate first
}

// Response (200)
{
  data: Record<string, string[]>,
  // e.g. { "title": ["Product Name"], "price": ["$29.99"] }
  url: string,
  title: string
}
```

**CDP call:** `Runtime.evaluate` with `document.querySelectorAll` + `textContent` extraction.

#### `GET /v1/browser/links`

Extract all links from the page.

```typescript
// Response (200)
{
  links: Array<{ href: string, text: string }>,
  url: string
}
```

#### `POST /v1/browser/execute`

Execute JavaScript in the page context.

```typescript
// Request
{ expression: string, awaitPromise?: boolean }

// Response (200)
{ result: any, type: string }
```

**CDP call:** `Runtime.evaluate`.

#### `GET /v1/browser/snapshot`

Get the accessibility tree of the current page.

```typescript
// Response (200)
{
  snapshot: string,    // text representation of accessibility tree
  url: string,
  title: string
}
```

**CDP call:** `Accessibility.getFullAXTree` or `DOM.getDocument` + role extraction.

### 3.6 Interaction

These are browser-level click/type/scroll that use CDP (target DOM elements by selector). They complement the desktop-level `xdotool` input which operates on raw X11 coordinates.

#### `POST /v1/browser/click`

```typescript
// Request
{
  selector: string,           // CSS selector
  button?: "left" | "right" | "middle",
  clickCount?: number,        // 1 = click, 2 = double-click
  timeout?: number,           // ms to wait for selector
}

// Response (200)
{ ok: true }
```

**CDP calls:** `DOM.querySelector` to find node, `DOM.getBoxModel` to get coordinates, `Input.dispatchMouseEvent`.

#### `POST /v1/browser/type`

```typescript
// Request
{
  selector: string,
  text: string,
  delay?: number,     // ms between keystrokes
  clear?: boolean,    // clear field first
}

// Response (200)
{ ok: true }
```

**CDP calls:** Focus element via `DOM.focus`, then `Input.dispatchKeyEvent` per character.

#### `POST /v1/browser/select`

```typescript
// Request
{ selector: string, value: string }

// Response (200)
{ ok: true }
```

#### `POST /v1/browser/hover`

```typescript
// Request
{ selector: string }

// Response (200)
{ ok: true }
```

#### `POST /v1/browser/scroll`

```typescript
// Request
{
  selector?: string,    // element to scroll (default: viewport)
  x?: number,           // horizontal scroll delta
  y?: number,           // vertical scroll delta
}

// Response (200)
{ ok: true }
```

#### `POST /v1/browser/upload`

Upload a file to a file input element.

```typescript
// Request
{
  selector: string,         // file input selector
  path: string,             // path to file inside the sandbox
}

// Response (200)
{ ok: true }
```

**CDP call:** `DOM.setFileInputFiles`.

#### `POST /v1/browser/dialog`

Handle a JavaScript dialog (alert/confirm/prompt).

```typescript
// Request
{
  accept: boolean,
  text?: string,     // for prompt dialogs
}

// Response (200)
{ ok: true }
```

**CDP call:** `Page.handleJavaScriptDialog`.

### 3.7 Monitoring

#### `GET /v1/browser/console`

Get console log messages.

```typescript
// Query params
level?: "log" | "warn" | "error" | "info" | "debug"
limit?: number        // max messages (default: 100)

// Response (200)
{
  messages: Array<{
    level: string,
    text: string,
    url?: string,
    line?: number,
    timestamp: string,
  }>
}
```

**CDP:** Subscribe to `Runtime.consoleAPICalled` events, buffer in memory.

#### `GET /v1/browser/network`

Get captured network requests.

```typescript
// Query params
limit?: number
urlPattern?: string   // regex filter

// Response (200)
{
  requests: Array<{
    url: string,
    method: string,
    status: number,
    mimeType: string,
    responseSize: number,
    duration: number,     // ms
    timestamp: string,
  }>
}
```

**CDP:** Subscribe to `Network.requestWillBeSent` + `Network.responseReceived`, buffer in memory.

### 3.8 Crawling

#### `POST /v1/browser/crawl`

Crawl pages starting from a URL.

```typescript
// Request
{
  url: string,
  maxPages?: number,       // default: 10, max: 100
  maxDepth?: number,       // default: 2
  allowedDomains?: string[], // restrict to these domains
  extract?: "markdown" | "html" | "text" | "links",  // what to return per page
}

// Response (200)
{
  pages: Array<{
    url: string,
    title: string,
    content: string,     // in the requested extract format
    links: string[],     // outgoing links found
    status: number,
    depth: number,
  }>,
  totalPages: number,
  truncated: boolean,    // true if maxPages was hit
}
```

**Implementation:** BFS crawl using the CDP-controlled browser. For each page:
1. Navigate via `Page.navigate`
2. Wait for load
3. Extract content (reuse markdown/html/links extraction logic)
4. Collect links, filter by domain/depth
5. Continue until maxPages or maxDepth

### 3.9 Browser Contexts (Persistent Profiles)

#### `GET /v1/browser/contexts`

List saved browser contexts (persistent cookie/storage profiles).

```typescript
// Response (200)
{
  contexts: Array<{
    id: string,
    name: string,
    createdAt: string,
    sizeBytes: number,
  }>
}
```

**Storage:** Each context is a Chromium `--user-data-dir` directory stored under `$STATE_DIR/browser-contexts/{id}/`.

#### `POST /v1/browser/contexts`

Create a named context.

```typescript
// Request
{ name: string }

// Response (201)
{ id: string, name: string, createdAt: string }
```

#### `DELETE /v1/browser/contexts/{id}`

Delete a context and its stored data.

#### Using a context

Pass `contextId` in the start request:

```typescript
POST /v1/browser/start
{ contextId: "ctx_abc123" }
```

This sets `--user-data-dir` to the context's directory, preserving cookies, localStorage, IndexedDB, etc. across browser sessions.

### 3.10 Cookies

#### `GET /v1/browser/cookies`

```typescript
// Query params
url?: string   // filter by URL

// Response (200)
{
  cookies: Array<{
    name: string,
    value: string,
    domain: string,
    path: string,
    expires: number,
    httpOnly: boolean,
    secure: boolean,
    sameSite: string,
  }>
}
```

**CDP call:** `Network.getCookies`.

#### `POST /v1/browser/cookies`

Set cookies.

```typescript
// Request
{
  cookies: Array<{
    name: string,
    value: string,
    domain?: string,
    path?: string,
    expires?: number,
    httpOnly?: boolean,
    secure?: boolean,
    sameSite?: "Strict" | "Lax" | "None",
  }>
}

// Response (200)
{ ok: true }
```

**CDP call:** `Network.setCookies`.

#### `DELETE /v1/browser/cookies`

Clear all cookies (or by name/domain filter).

```typescript
// Query params
name?: string
domain?: string
```

---

## 4. Rust Module Structure

### New files

```
server/packages/sandbox-agent/src/
├── browser_types.rs        # Request/response DTOs (serde + utoipa + schemars)
├── browser_errors.rs       # BrowserProblem error type (mirrors DesktopProblem)
├── browser_runtime.rs      # BrowserRuntime state machine (~800 lines)
├── browser_cdp.rs          # CDP client: persistent WS connection to Chromium
├── browser_install.rs      # install browser CLI logic
├── browser_crawl.rs        # Crawl implementation
└── browser_context.rs      # Persistent profile (user-data-dir) management
```

### Modified files

```
server/packages/sandbox-agent/src/
├── cli.rs                  # Add Browser variant to InstallCommand
├── router.rs               # Add /v1/browser/* routes
├── lib.rs                  # Add module declarations
└── state.rs                # Add BrowserRuntime to app state (or equivalent)
```

### BrowserRuntime

```rust
pub struct BrowserRuntime {
    config: BrowserRuntimeConfig,
    process_runtime: Arc<ProcessRuntime>,
    desktop_streaming_manager: Arc<DesktopStreamingManager>,  // shared with DesktopRuntime
    desktop_recording_manager: Arc<DesktopRecordingManager>,  // shared
    cdp_client: Arc<Mutex<Option<CdpClient>>>,
    inner: Arc<Mutex<BrowserRuntimeState>>,
}

#[derive(Debug)]
struct BrowserRuntimeState {
    state: BrowserState,
    xvfb_process_id: Option<String>,
    chromium_process_id: Option<String>,
    display: Option<String>,
    resolution: Option<DesktopResolution>,
    started_at: Option<String>,
    last_error: Option<BrowserErrorInfo>,
    // Monitoring buffers
    console_messages: VecDeque<ConsoleMessage>,   // bounded ring buffer, max 1000
    network_requests: VecDeque<NetworkRequest>,    // bounded ring buffer, max 1000
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserState {
    Inactive,
    InstallRequired,
    Starting,
    Active,
    Stopping,
    Failed,
}
```

### CdpClient

```rust
/// Persistent WebSocket connection to Chromium's CDP server.
pub struct CdpClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: AtomicU64,
}

impl CdpClient {
    /// Connect to Chromium CDP at ws://127.0.0.1:9222/devtools/browser/{id}
    pub async fn connect() -> Result<Self, SandboxError>;

    /// Send a CDP command and wait for the response.
    pub async fn send(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, SandboxError>;

    /// Subscribe to CDP events (e.g., Runtime.consoleAPICalled).
    pub async fn subscribe(&self, event: &str, callback: impl Fn(serde_json::Value));
}
```

### Router registration

Add to the router builder (follow existing patterns in `router.rs`):

```rust
// Browser lifecycle
.route("/v1/browser/start", post(browser_start))
.route("/v1/browser/stop", post(browser_stop))
.route("/v1/browser/status", get(browser_status))

// CDP proxy
.route("/v1/browser/cdp", get(browser_cdp_ws))

// Navigation
.route("/v1/browser/navigate", post(browser_navigate))
.route("/v1/browser/back", post(browser_back))
.route("/v1/browser/forward", post(browser_forward))
.route("/v1/browser/reload", post(browser_reload))
.route("/v1/browser/wait", post(browser_wait))

// Tabs
.route("/v1/browser/tabs", get(browser_tabs_list))
.route("/v1/browser/tabs", post(browser_tabs_create))
.route("/v1/browser/tabs/:tab_id/activate", post(browser_tab_activate))
.route("/v1/browser/tabs/:tab_id", delete(browser_tab_close))

// Content extraction
.route("/v1/browser/screenshot", get(browser_screenshot))
.route("/v1/browser/pdf", get(browser_pdf))
.route("/v1/browser/content", get(browser_content))
.route("/v1/browser/markdown", get(browser_markdown))
.route("/v1/browser/scrape", post(browser_scrape))
.route("/v1/browser/links", get(browser_links))
.route("/v1/browser/execute", post(browser_execute))
.route("/v1/browser/snapshot", get(browser_snapshot))

// Interaction
.route("/v1/browser/click", post(browser_click))
.route("/v1/browser/type", post(browser_type))
.route("/v1/browser/select", post(browser_select))
.route("/v1/browser/hover", post(browser_hover))
.route("/v1/browser/scroll", post(browser_scroll))
.route("/v1/browser/upload", post(browser_upload))
.route("/v1/browser/dialog", post(browser_dialog))

// Monitoring
.route("/v1/browser/console", get(browser_console))
.route("/v1/browser/network", get(browser_network))

// Crawling
.route("/v1/browser/crawl", post(browser_crawl))

// Contexts
.route("/v1/browser/contexts", get(browser_contexts_list))
.route("/v1/browser/contexts", post(browser_contexts_create))
.route("/v1/browser/contexts/:context_id", delete(browser_contexts_delete))

// Cookies
.route("/v1/browser/cookies", get(browser_cookies_get))
.route("/v1/browser/cookies", post(browser_cookies_set))
.route("/v1/browser/cookies", delete(browser_cookies_delete))
```

Total: **33 new endpoints**

---

## 5. TypeScript SDK

### New methods on `SandboxAgent` class

```typescript
// Lifecycle
startBrowser(request?: BrowserStartRequest): Promise<BrowserStatusResponse>
stopBrowser(): Promise<BrowserStatusResponse>
getBrowserStatus(): Promise<BrowserStatusResponse>

// CDP
getBrowserCdpUrl(): string  // returns ws://host:port/v1/browser/cdp

// Navigation
browserNavigate(request: BrowserNavigateRequest): Promise<BrowserPageInfo>
browserBack(): Promise<BrowserPageInfo>
browserForward(): Promise<BrowserPageInfo>
browserReload(request?: BrowserReloadRequest): Promise<BrowserPageInfo>
browserWait(request: BrowserWaitRequest): Promise<{ found: boolean }>

// Tabs
getBrowserTabs(): Promise<BrowserTabListResponse>
createBrowserTab(request?: { url?: string }): Promise<BrowserTabInfo>
activateBrowserTab(tabId: string): Promise<BrowserTabInfo>
closeBrowserTab(tabId: string): Promise<{ ok: boolean }>

// Content extraction
takeBrowserScreenshot(request?: BrowserScreenshotRequest): Promise<Uint8Array>
getBrowserPdf(request?: BrowserPdfRequest): Promise<Uint8Array>
getBrowserContent(request?: { selector?: string }): Promise<BrowserContentResponse>
getBrowserMarkdown(): Promise<BrowserMarkdownResponse>
scrapeBrowser(request: BrowserScrapeRequest): Promise<BrowserScrapeResponse>
getBrowserLinks(): Promise<BrowserLinksResponse>
executeBrowserScript(request: BrowserExecuteRequest): Promise<BrowserExecuteResponse>
getBrowserSnapshot(): Promise<BrowserSnapshotResponse>

// Interaction
browserClick(request: BrowserClickRequest): Promise<{ ok: boolean }>
browserType(request: BrowserTypeRequest): Promise<{ ok: boolean }>
browserSelect(request: BrowserSelectRequest): Promise<{ ok: boolean }>
browserHover(request: { selector: string }): Promise<{ ok: boolean }>
browserScroll(request: BrowserScrollRequest): Promise<{ ok: boolean }>
browserUpload(request: BrowserUploadRequest): Promise<{ ok: boolean }>
browserDialog(request: BrowserDialogRequest): Promise<{ ok: boolean }>

// Monitoring
getBrowserConsole(request?: BrowserConsoleQuery): Promise<BrowserConsoleResponse>
getBrowserNetwork(request?: BrowserNetworkQuery): Promise<BrowserNetworkResponse>

// Crawling
crawlBrowser(request: BrowserCrawlRequest): Promise<BrowserCrawlResponse>

// Contexts
getBrowserContexts(): Promise<BrowserContextListResponse>
createBrowserContext(request: { name: string }): Promise<BrowserContextInfo>
deleteBrowserContext(contextId: string): Promise<void>

// Cookies
getBrowserCookies(request?: { url?: string }): Promise<BrowserCookiesResponse>
setBrowserCookies(request: { cookies: BrowserCookie[] }): Promise<{ ok: boolean }>
deleteBrowserCookies(request?: { name?: string, domain?: string }): Promise<void>
```

### Types (in `sdks/typescript/src/types/browser.ts`)

```typescript
export interface BrowserStartRequest {
  width?: number;
  height?: number;
  dpi?: number;
  url?: string;
  headless?: boolean;
  contextId?: string;
  streamVideoCodec?: string;
  streamAudioCodec?: string;
  streamFrameRate?: number;
  webrtcPortRange?: string;
  recordingFps?: number;
}

export interface BrowserStatusResponse {
  state: "active" | "starting" | "inactive" | "install_required" | "failed";
  display?: string;
  resolution?: { width: number; height: number; dpi?: number };
  startedAt?: string;
  cdpUrl?: string;
  url?: string;
  missingDependencies: string[];
  installCommand?: string;
  processes: Array<{ name: string; pid?: number; running: boolean }>;
  lastError?: { code: string; message: string };
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserPageInfo {
  url: string;
  title: string;
  status?: number;
}

export interface BrowserNavigateRequest {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface BrowserScreenshotRequest {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
  selector?: string;
}

export interface BrowserClickRequest {
  selector: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  timeout?: number;
}

export interface BrowserTypeRequest {
  selector: string;
  text: string;
  delay?: number;
  clear?: boolean;
}

export interface BrowserCrawlRequest {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  allowedDomains?: string[];
  extract?: "markdown" | "html" | "text" | "links";
}

// ... (remaining types follow the same pattern from the HTTP API section)
```

---

## 6. Inspector UI: Browser Tab

### New file: `frontend/packages/inspector/src/components/debug/BrowserTab.tsx`

The Browser tab follows the same patterns as `DesktopTab.tsx` but with browser-specific sections.

### Tab registration

In `DebugPanel.tsx`:

```typescript
import BrowserTab from "./BrowserTab";

type DebugTab = "log" | "events" | "agents" | "desktop" | "browser" | "mcp" | "skills" | "processes" | "run-process";

// In the tab bar, add after the desktop tab:
<button className={`debug-tab ${debugTab === "browser" ? "active" : ""}`} onClick={() => onDebugTabChange("browser")}>
  <Globe className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
  Browser
</button>

// In the tab content area:
{debugTab === "browser" && <BrowserTab getClient={getClient} />}
```

Use `Globe` icon from lucide-react (to differentiate from the `Monitor` icon on the Desktop tab).

### BrowserTab sections

The component should have these card sections, following the same card/card-header/card-title patterns as DesktopTab:

#### Section 1: Runtime Control

- State pill (active/inactive/install_required/failed)
- Status grid: URL, Resolution, Started
- Inputs: Width, Height, URL, Context dropdown
- Start/Stop buttons
- Auto-refresh status every 5s when active

#### Section 2: Live View (Neko stream)

When browser is active and streaming:
- Reuse the `<DesktopViewer>` component from `@sandbox-agent/react`
- Same WebRTC stream, same interaction model
- Show current URL above the viewer
- Navigation bar: Back, Forward, Reload buttons + URL input

```tsx
<div className="browser-nav-bar">
  <button onClick={handleBack}><ArrowLeft size={14} /></button>
  <button onClick={handleForward}><ArrowRight size={14} /></button>
  <button onClick={handleReload}><RefreshCw size={14} /></button>
  <input
    className="browser-url-input"
    value={currentUrl}
    onKeyDown={(e) => e.key === "Enter" && handleNavigate(currentUrl)}
    onChange={(e) => setCurrentUrl(e.target.value)}
  />
</div>
<DesktopViewer client={viewerClient} height={480} />
```

#### Section 3: Screenshot (fallback when not streaming)

Same as desktop screenshot section:
- Format selector (PNG/JPEG/WebP)
- Quality input
- Full page checkbox (browser-specific)
- Selector input (browser-specific, optional CSS selector)
- Screenshot button + preview

#### Section 4: Tabs

- List of open tabs with URL and title
- Active tab highlighted
- Per-tab actions: Activate, Close
- "New Tab" button with URL input

```
┌─────────────────────────────────────────────────┐
│ Tabs                                            │
├─────────────────────────────────────────────────┤
│ ● https://example.com - Example Domain    [X]  │
│   https://google.com - Google             [X]  │
│                                                 │
│ [+ New Tab]  URL: [________________] [Open]    │
└─────────────────────────────────────────────────┘
```

#### Section 5: Console

- Level filter pills: All, Log, Warn, Error, Info
- Scrollable message list with level-colored indicators
- Auto-refresh every 3s when active
- Clear button

```
┌─────────────────────────────────────────────────┐
│ Console                          [Clear] [↻]   │
├─────────────────────────────────────────────────┤
│ [All] [Log] [Warn] [Error] [Info]              │
│                                                 │
│ LOG  Hello world                                │
│ WARN Deprecation warning: ...                   │
│ ERR  Uncaught TypeError: ...                    │
│      at foo.js:42                               │
└─────────────────────────────────────────────────┘
```

#### Section 6: Network

- Request list showing method, URL (truncated), status, size, duration
- URL pattern filter input
- Auto-refresh every 3s
- Click to expand shows full URL and response details

```
┌─────────────────────────────────────────────────┐
│ Network                          [Clear] [↻]   │
├─────────────────────────────────────────────────┤
│ Filter: [_________________________]             │
│                                                 │
│ GET  /api/data          200  1.2KB   45ms      │
│ POST /api/submit        201  0.3KB   120ms     │
│ GET  /styles.css        200  15KB    12ms      │
└─────────────────────────────────────────────────┘
```

#### Section 7: Content Tools

Extraction tools in a compact form:
- "Get HTML" button
- "Get Markdown" button
- "Get Links" button
- "Get Snapshot" (accessibility tree) button
- Output textarea showing the result

#### Section 8: Recording

Reuse the same recording UI from DesktopTab (since it's the same Xvfb/ffmpeg infrastructure):
- Start/Stop recording
- FPS input
- Recording list with download/delete

#### Section 9: Contexts

- List of saved contexts with name, created date, size
- Create new context form (name input)
- Delete button per context
- "Use" button that sets contextId for next start

#### Section 10: Diagnostics

Same pattern as desktop:
- Last error details
- Process list (Xvfb, Chromium, Neko) with PIDs and running state
- Runtime log path

### State management

```typescript
const BrowserTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  // Runtime
  const [status, setStatus] = useState<BrowserStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Config inputs
  const [width, setWidth] = useState("1280");
  const [height, setHeight] = useState("720");
  const [startUrl, setStartUrl] = useState("");
  const [selectedContext, setSelectedContext] = useState<string | null>(null);

  // Live view
  const [liveViewActive, setLiveViewActive] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");

  // Screenshot
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotFormat, setScreenshotFormat] = useState<"png" | "jpeg" | "webp">("png");
  const [screenshotFullPage, setScreenshotFullPage] = useState(false);

  // Tabs
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [newTabUrl, setNewTabUrl] = useState("");

  // Console
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMessage[]>([]);
  const [consoleFilter, setConsoleFilter] = useState<string | null>(null);

  // Network
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [networkFilter, setNetworkFilter] = useState("");

  // Content
  const [contentResult, setContentResult] = useState<string | null>(null);
  const [contentType, setContentType] = useState<"html" | "markdown" | "links" | "snapshot">("html");

  // Recording (reuse desktop recording state pattern)
  const [recordings, setRecordings] = useState<DesktopRecordingInfo[]>([]);
  const [recordingFps, setRecordingFps] = useState("30");

  // Contexts
  const [contexts, setContexts] = useState<BrowserContextInfo[]>([]);
  const [newContextName, setNewContextName] = useState("");

  // ... (callbacks, effects, render follow DesktopTab patterns)
};
```

---

## 7. React Component: `BrowserViewer`

### New file: `sdks/react/src/BrowserViewer.tsx`

A thin wrapper around `DesktopViewer` that adds a navigation bar. This is the reusable component for embedding in any React app.

```typescript
export interface BrowserViewerProps {
  client: BrowserViewerClient;
  className?: string;
  style?: CSSProperties;
  height?: number | string;
  showNavigationBar?: boolean;  // default: true
  showStatusBar?: boolean;      // default: true
  onNavigate?: (url: string) => void;
  onConnect?: (status: DesktopStreamReadyStatus) => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export type BrowserViewerClient = Pick<SandboxAgent,
  | "connectDesktopStream"
  | "browserNavigate"
  | "browserBack"
  | "browserForward"
  | "browserReload"
  | "getBrowserStatus"
>;
```

Export from `sdks/react/src/index.ts`:

```typescript
export { BrowserViewer } from "./BrowserViewer";
export type { BrowserViewerProps, BrowserViewerClient } from "./BrowserViewer";
```

---

## 8. Desktop Integration

### Shared infrastructure

The browser runtime shares these components with the desktop runtime:

| Component | Desktop | Browser | Shared? |
|-----------|---------|---------|---------|
| Xvfb | Yes | Yes | Same launch logic, different defaults (browser: 1280x720) |
| Openbox | Yes | No | Browser runs Chromium directly |
| Neko streaming | Yes | Yes | Same `DesktopStreamingManager` instance |
| Recording (ffmpeg) | Yes | Yes | Same `DesktopRecordingManager` instance |
| Screenshot (ImageMagick) | Yes | Yes | Desktop-level screenshots via same `import` command |
| Mouse/keyboard (xdotool) | Yes | Yes | Same desktop input endpoints work |
| Clipboard | Yes | Yes | Same X11 clipboard |

### Mutual exclusivity

Desktop mode and browser mode are mutually exclusive. Only one can be active at a time (they share the X11 display). The `BrowserRuntime` should check that `DesktopRuntime` is not active before starting, and vice versa. Return a `409 Conflict` if the other mode is active.

Alternatively, browser mode could be a "mode" of the desktop runtime (add a `mode` field to `DesktopStartRequest`). This avoids two separate runtime managers and simplifies shared state. **Recommendation: implement as a mode of the existing desktop runtime** to maximize code reuse.

### Desktop runtime mode approach

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopMode {
    Desktop,  // Xvfb + Openbox (current behavior)
    Browser,  // Xvfb + Chromium (no window manager)
}
```

`POST /v1/browser/start` internally calls `desktop_runtime.start()` with `mode: Browser`. The browser-specific endpoints (CDP, navigate, etc.) are only available when the mode is `Browser`.

---

## 9. Error Handling

### BrowserProblem (mirrors DesktopProblem)

```rust
pub enum BrowserProblem {
    NotActive,            // 409 - browser is not running
    AlreadyActive,        // 409 - browser is already running
    DesktopConflict,      // 409 - desktop mode is active, cannot start browser
    InstallRequired,      // 424 - missing dependencies
    StartFailed(String),  // 500 - startup sequence failed
    CdpError(String),     // 502 - CDP communication error
    Timeout(String),      // 504 - operation timed out
    NotFound(String),     // 404 - tab/context/element not found
    InvalidSelector(String), // 400 - bad CSS selector
}
```

All errors return `application/problem+json`:

```json
{
  "type": "tag:sandboxagent.dev,2025:browser/not-active",
  "title": "Browser Not Active",
  "status": 409,
  "detail": "The browser is not running. Call POST /v1/browser/start first."
}
```

---

## 10. Testing

### Integration tests

New file: `server/packages/sandbox-agent/tests/browser_api.rs`

Test categories:
1. **Lifecycle**: start, status, stop
2. **Navigation**: navigate, back, forward, reload
3. **Tabs**: create, list, activate, close
4. **Screenshots**: PNG/JPEG/WebP, full page, element
5. **Content**: HTML, markdown, links, snapshot
6. **Interaction**: click, type, scroll (against a test HTML page)
7. **Monitoring**: console messages, network requests
8. **Crawling**: multi-page crawl with depth/page limits
9. **Contexts**: create, use, delete
10. **CDP proxy**: Playwright connects through proxy

### Test HTML pages

Serve static test pages from within the test via a simple HTTP server inside the sandbox. This avoids network dependencies.

### Docker test image

Update `docker/test-agent/Dockerfile` to include Chromium (it's already in `docker/test-common-software/Dockerfile`).

### Run command

```bash
cargo test -p sandbox-agent --test browser_api
```

