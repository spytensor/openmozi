# MOZI UI Platform — Lovable Implementation Spec

> This document is a self-contained prompt specification. Hand it to Lovable's agent to build the MOZI frontend from scratch.
>
> Current implementation note: for post-#313 hardening, follow
> `docs/WEB-UI-RUNTIME-UX-TRACKER.md` when it conflicts with this original
> bootstrap spec. In particular, the earlier "English only / no i18n" assumption
> is no longer valid.

---

## 1. What You Are Building

**MOZI** is a personal AI agent operating system. Think of it as "Jarvis for your computer." The backend is already built (Node.js + Fastify + SQLite + WebSocket). You are building the **web frontend** — a real-time dashboard and chat interface that connects to this backend.

The app has **one user** (the operator). There is no sign-up flow, no multi-user UI. Auth is a simple pairing code entered once.

---

## 2. Tech Stack (Non-Negotiable)

| Layer | Choice |
|-------|--------|
| Framework | React 19 + TypeScript (strict) |
| Build | Vite 7 |
| Styling | Tailwind CSS 4 (use `@tailwindcss/vite` plugin) |
| Icons | `lucide-react` |
| Charts | `recharts` |
| Markdown | `react-markdown` + `remark-gfm` |
| Animation | `framer-motion` |
| State | React hooks only (no Redux, no Zustand, no context-heavy patterns) |
| Routing | No router library. Use simple `useState<AppView>` to switch views. |

Do NOT add: shadcn/ui, Radix, Headless UI, React Router, or any component library. Build components from scratch with Tailwind.

---

## 3. Design Language

### Visual Identity
- **Dark mode only.** Background: `#0a0a0f` (near-black with blue tint). Surface cards: `#12121a`.
- Accent color: `#6366f1` (indigo-500). Success: `#22c55e`. Warning: `#f59e0b`. Error: `#ef4444`.
- Font: system monospace stack (`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`).
- Border radius: `8px` for cards, `6px` for buttons, `4px` for badges.
- Borders: `1px solid rgba(255,255,255,0.06)`.
- Subtle glow effects on active/focused elements using `box-shadow: 0 0 20px rgba(99,102,241,0.15)`.

### Layout Philosophy
- **Information-dense.** This is an operator console, not a consumer app. Maximize data per pixel.
- No excessive whitespace. Compact padding (`p-3`, `p-4`, not `p-8`).
- Use subtle dividers (`h-px bg-white/5`) between sections, not heavy cards-in-cards.
- Animations should be fast (150-200ms) and functional, never decorative.

### Typography
- Base: 14px. Small/meta: 12px. Section headers: 13px semibold uppercase tracking-wide.
- Use `text-white/90` for primary text, `text-white/50` for secondary, `text-white/30` for disabled.

---

## 4. Application Structure

The app has **4 top-level views** toggled from the TopBar:

```
┌─────────────────────────────────────────────────┐
│  TopBar (always visible)                        │
├──────────┬──────────────────────────────────────┤
│ Session  │                                      │
│ Sidebar  │     Main Content Area                │
│ (toggle) │     (Chat / Dashboard / Skills /     │
│          │      Settings)                       │
│          │                                      │
│          ├──────────────────────────────────────┤
│          │     InputBar (chat view only)         │
└──────────┴──────────────────────────────────────┘
```

### 4.1 TopBar

Fixed top bar. Contains:
- **Left:** Hamburger icon → toggles Session Sidebar. MOZI logo (small, 24px). Connection status dot (green/yellow/red).
- **Center:** View switcher tabs: `Chat` | `Dashboard` | `Skills` | `Settings`. Active tab has indigo underline.
- **Right:** Session state badge (`IDLE` / `WORKING` / `RESPONDING` — pulsing dot for non-idle). Current model name (e.g., "claude-sonnet-4-20250514"). Optional workspace diagnostics toggle (gear icon).

### 4.2 Chat View (Default)

The primary view. Two sections: message list + input bar.

#### Message List
- Scrollable, auto-scroll to bottom on new messages.
- **User messages:** Right-aligned, indigo background bubble, rounded corners.
- **Assistant messages:** Left-aligned, no background (or very subtle `bg-white/3`), full-width. Render markdown with syntax highlighting for code blocks.
- **System messages:** Centered, small text, `text-white/40`, no bubble.
- **Streaming:** Show assistant message growing in real-time as `stream_chunk` arrives. Show a small animated typing indicator (3 dots) during `stream_start` before first chunk.
- **Tool events:** Inline collapsible cards showing tool name, intent, status (spinner for running, checkmark for success, X for error), and elapsed time. Group consecutive tool events visually.
- **Task updates:** Compact progress cards showing task title, status badge, and optional progress bar.
- **Approval requests:** Highlighted card with description, "Approve" (green) and "Reject" (red) buttons. Pending state shows pulsing border.
- **Artifacts:** Collapsible card with title, status badge, and JSON data viewer (expandable).

#### InputBar
- Fixed bottom. Full-width text input with monospace font.
- Send button (arrow icon) on the right, disabled when disconnected.
- Show "Queued (N)" badge when messages are queued during busy state.
- Show subtle "MOZI is working..." indicator when `busy=true`.
- Support `/` commands — show autocomplete dropdown above input when user types `/`.

### 4.3 Dashboard View

A data-dense operational dashboard. Fetch data from REST APIs on mount.

**Layout:** 2-column grid on desktop, single column on mobile.

#### Top Row: Overview Cards (4 cards)
Fetch from `GET /api/dashboard/overview`. Each card shows:
- Total tasks (with completed/failed breakdown)
- Active sessions count
- Total cost (USD, formatted)
- System uptime

#### Middle: Task History Table
Fetch from `GET /api/dashboard/tasks?limit=50`.
- Sortable table: ID, Title, Status (color-coded badge), Created, Duration.
- Status badges: `pending` (gray), `running` (blue pulse), `completed` (green), `failed` (red).
- Click row to expand and show task details.

#### Middle: Cost Analysis Chart
Fetch from `GET /api/dashboard/costs`.
- Bar chart (recharts) showing cost per day/model.
- Show total and breakdown by provider.

#### Bottom: SLO Panel
Fetch from `GET /api/dashboard/slo`.
- Show SLO metrics: latency p50/p95/p99, success rate, error rate.
- Use gauge-style indicators (green/yellow/red zones).

### 4.4 Skills View (New)

Fetch from `GET /api/skills` (you'll need to check if this endpoint exists; if not, show a placeholder).

- Grid of skill cards. Each card shows:
  - Skill name and version
  - Description (first 2 lines)
  - Status badge (active/disabled)
  - Trigger pattern (e.g., "when user says /code")
- Search/filter bar at top.
- Click card to expand full skill details.

### 4.5 Settings View (New)

Fetch from `GET /api/config`.

- Grouped settings panels:
  - **LLM Providers:** Show configured providers, active model, API key status (masked).
  - **System:** Language, timezone, log level.
  - **Security:** Pairing status, session info.
- Each setting is editable inline. Save via `POST /api/config`.

---

## 5. Session Sidebar

Slide-in panel from left (overlays on mobile, pushes content on desktop ≥1280px).

- **Header:** "Sessions" title + "New Session" button (+ icon).
- **Session list:** Scrollable. Each item shows:
  - Session title (or "Untitled" fallback)
  - Last message timestamp (relative: "2m ago", "Yesterday")
  - Active indicator (indigo dot) for current session
- Click to switch session (loads history from `GET /api/sessions/:id/messages`).
- **Footer:** Slash command shortcuts, Logout button.

---

## 6. Workspace Diagnostics Panel (Optional, Toggle)

Right-side panel (340px wide) that shows real-time system internals. Only visible when diagnostics mode is enabled (URL param `?diagnostics=1` or localStorage `mozi:diagnostics=1`).

**Tabs:** Brain | Agents | Tools | Observer

#### Brain Tab
- **DAG View:** Visual task dependency graph. Nodes are colored by status. Simple top-down layout (no need for a graph library — use CSS grid or absolute positioning).
- **Token Budget Gauge:** Circular or bar gauge showing used/total tokens for current context.
- **Provider Status:** List of LLM providers with health indicator (green dot = healthy, red = down).

#### Agents Tab
- List of active sub-agents with: ID, status, current task, uptime.

#### Tools Tab
- Real-time feed of tool executions. Show: tool name, phase (start/end), status, elapsed time.
- Auto-scroll, max 50 entries.

#### Observer Tab
- Alert feed. Each alert: severity icon (info/warn/error), message, timestamp.
- Error count badge on tab.

---

## 7. Backend Connection

### 7.1 WebSocket Protocol

Connect to `ws://{host}/ws` (or `wss://` for HTTPS). On connect, send:

```json
{
  "type": "hello",
  "client": "mozi-ui",
  "capabilities": ["streaming_v1", "workspace_v1", "artifact_v1", "execution_v1"]
}
```

**Inbound message types (server → client):**

| Type | Description |
|------|-------------|
| `message` | Chat message. Fields: `role` ("assistant"\|"system"), `content` (string). |
| `stream_start` | Streaming begins. Fields: `requestId`. |
| `stream_chunk` | Streaming token. Fields: `requestId`, `content`. |
| `stream_end` | Streaming complete. Fields: `requestId`, `content` (full text). |
| `tool_event` | Tool execution update. Fields: `phase` ("start"\|"end"), `tool`, `status`, `intent`, `result`, `elapsed_ms`, `callId`, `taskId`. |
| `task_update` | Task status change. Fields: `task_id`, `title`, `status`, `progress` (0-100). |
| `approval_request` | Needs user approval. Fields: `id`, `description`. |
| `error` | Error message. Fields: `message`. |
| `session_update` | Session title changed. Fields: `sessionId`, `title`. |
| `artifact_open` | New artifact. Fields: `artifact` object (id, plugin_id, title, status, data). |
| `artifact_patch` | Update artifact. Fields: `artifactId`, `patch` object. |
| `artifact_close` | Close artifact. Fields: `artifactId`. |
| `workspace_*` | Diagnostics data (state, dag, agents, tools, budget, providers, alert, session_state). |

**Outbound message types (client → server):**

| Type | Fields | Description |
|------|--------|-------------|
| `hello` | `client`, `capabilities` | Handshake on connect. |
| `message` | `content`, `sessionId?` | Send user message. |
| `approve` | `id` | Approve a pending request. |
| `reject` | `id` | Reject a pending request. |
| `ping` | — | Heartbeat (send every 25s). |
| `subscribe_workspace` | — | Enable diagnostics stream. |
| `unsubscribe_workspace` | — | Disable diagnostics stream. |

**Reconnection:** Exponential backoff starting at 1s, max 30s. Show "Reconnecting..." in TopBar.

### 7.2 REST API Endpoints

All endpoints accept/return JSON. Auth via `Authorization: Bearer {token}` header (token stored in `localStorage` as `mozi_token`).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/auth/status` | Check if paired |
| POST | `/api/auth/pair` | Pair with code. Body: `{ code: string }`. Returns `{ token }`. |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create new session. Returns `{ session: { id } }`. |
| GET | `/api/sessions/:id/messages` | Get session message history |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/history` | Legacy: get recent messages |
| GET | `/api/config` | Get system config |
| POST | `/api/config` | Update config |
| GET | `/api/dashboard/overview` | Dashboard summary cards |
| GET | `/api/dashboard/tasks?limit=N` | Task history |
| GET | `/api/dashboard/costs` | Cost breakdown |
| GET | `/api/dashboard/models` | Model usage stats |
| GET | `/api/dashboard/slo` | SLO metrics |
| GET | `/api/tenant/usage` | Tenant resource usage |
| GET | `/api/tenant/quotas` | Tenant quota limits |
| GET | `/api/onboarding/status` | Check if onboarding is complete |

---

## 8. Auth Flow

1. On load, check `GET /api/auth/status`.
2. If unpaired, show **PairingGate**: centered card with logo, pairing code input (6-char), submit button.
3. On submit, `POST /api/auth/pair` with code. Store returned token in `localStorage`.
4. After pairing, check `GET /api/onboarding/status`. If not completed, show **OnboardingWizard** (a multi-step form — can be simple for now, just provider selection + confirmation).
5. Once paired + onboarded, show the main app.

---

## 9. Responsive Behavior

- **Desktop (≥1280px):** Session sidebar pushes content. Workspace panel on right.
- **Tablet (768-1279px):** Sidebar overlays with backdrop. No workspace panel.
- **Mobile (<768px):** Full-screen views. Sidebar is full-width overlay. Input bar sticks to bottom with safe-area padding.

---

## 10. File Structure

```
ui/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                    # Entry point
│   ├── App.tsx                     # Root component, view router, auth gate
│   ├── index.css                   # Tailwind imports + custom properties
│   ├── types.ts                    # All TypeScript interfaces (messages, sessions, etc.)
│   ├── types/
│   │   ├── workspace.ts            # Workspace/diagnostics types
│   │   └── management.ts           # Dashboard/management types
│   ├── hooks/
│   │   ├── useWebSocket.ts         # WebSocket connection + reconnect + heartbeat
│   │   ├── useChat.ts              # Chat message state + streaming assembly
│   │   ├── useSession.ts           # Active session management
│   │   ├── useAuth.ts              # Auth state (unpaired/paired) + pairing flow
│   │   ├── useApi.ts               # Generic REST API helper
│   │   ├── useWorkspace.ts         # Workspace diagnostics state
│   │   └── useDashboard.ts         # Dashboard data fetching
│   ├── lib/
│   │   └── utils.ts                # cn() helper, formatTime, etc.
│   ├── components/
│   │   ├── layout/
│   │   │   └── TopBar.tsx
│   │   ├── auth/
│   │   │   └── PairingGate.tsx
│   │   ├── onboarding/
│   │   │   └── OnboardingWizard.tsx
│   │   ├── sessions/
│   │   │   └── SessionSidebar.tsx
│   │   ├── chat/
│   │   │   ├── ChatView.tsx        # Message list container
│   │   │   ├── MessageBubble.tsx   # Single message renderer
│   │   │   ├── InputBar.tsx        # Text input + send button
│   │   │   ├── ApprovalCard.tsx    # Approval request UI
│   │   │   ├── TaskCard.tsx        # Task progress card
│   │   │   ├── ArtifactCard.tsx    # Artifact viewer
│   │   │   └── ToolEventCard.tsx   # Tool execution inline card
│   │   ├── dashboard/
│   │   │   ├── DashboardView.tsx   # Dashboard layout
│   │   │   ├── OverviewCards.tsx   # Summary stat cards
│   │   │   ├── TaskHistory.tsx     # Task table
│   │   │   ├── CostAnalysis.tsx    # Cost chart
│   │   │   ├── SloPanel.tsx        # SLO gauges
│   │   │   └── ConfigViewer.tsx    # Config display
│   │   ├── skills/
│   │   │   └── SkillsView.tsx      # Skills grid
│   │   ├── settings/
│   │   │   └── SettingsView.tsx    # Settings panels
│   │   └── workspace/
│   │       ├── WorkspacePanel.tsx   # Right-side diagnostics panel
│   │       ├── DAGView.tsx         # Task DAG visualization
│   │       ├── TokenBudgetGauge.tsx
│   │       ├── ProviderStatus.tsx
│   │       ├── SubAgentMonitor.tsx
│   │       ├── ToolPipeline.tsx
│   │       └── ObserverAlerts.tsx
```

---

## 11. Key Implementation Notes

1. **WebSocket is the primary data channel.** Chat messages, streaming, tool events, task updates, and workspace diagnostics all come over a single WebSocket. REST is only for initial data loading and CRUD operations.

2. **Streaming assembly:** When `stream_start` arrives, create a new assistant message. Append content on each `stream_chunk`. Finalize on `stream_end`. Use `requestId` to correlate chunks to the correct message.

3. **Message queue for busy state:** When the backend is busy (session state ≠ IDLE, or streaming is active), queue user messages locally. Send them one at a time when the backend returns to IDLE. Show queue count in the input bar.

4. **Tool events are ephemeral UI.** Show them inline in the chat flow but they don't need to persist. Show a spinner for `phase=start`, result for `phase=end`. Collapse after a few seconds or when the next message arrives.

5. **No mock data.** All data comes from the real backend. If an API endpoint returns an error or empty data, show an appropriate empty state, not placeholder content.

6. **Vite dev server proxies to backend.** In `vite.config.ts`, proxy `/api` and `/ws` to `http://localhost:3000` (the MOZI backend default port).

---

## 12. What NOT to Build

- No user registration / multi-user auth UI
- No file upload UI (not supported yet)
- No voice input
- No notification system / push notifications
- No i18n in the original bootstrap scope. This is superseded by
  `docs/WEB-UI-RUNTIME-UX-TRACKER.md`: the current product must use an explicit
  locale architecture and must not hard-code or mix user-facing language.
- No PWA / service worker
- No E2E tests (unit tests optional but not required)
- No storybook
- No analytics / telemetry
- No dark/light mode toggle (dark only)

---

## 13. Acceptance Criteria

The UI is "done" when:

1. Pairing flow works: enter code → get token → see main app.
2. Chat works: send message → see streaming response → see tool events inline.
3. Approval flow works: see approval card → click approve/reject → see status update.
4. Session management works: create new session, switch between sessions, see history.
5. Dashboard loads and shows real data from all 4 API endpoints.
6. WebSocket reconnects automatically on disconnect.
7. Mobile layout is usable (chat + input works on phone-width screen).
8. Diagnostics panel shows real-time workspace data when enabled.

---

*This spec describes the complete MOZI frontend. Build it module by module: auth → chat → dashboard → workspace. Each module should work independently before integrating.*
