# CoreLink 3D

> AI-powered 3D viewport with local LLM integration.
> Total Black aesthetic. macOS only.

---

## Quick Start

1. Unzip `CoreLink3D.zip` anywhere on your Mac
2. Double-click `start.command` in Finder
3. If macOS blocks it: **System Settings → Privacy & Security → Open Anyway**
4. The app opens automatically in your browser

**That's it. No terminal. No manual commands.**

---

## What the Launcher Does Automatically

| Step | Action |
|------|--------|
| 1 | Verifies macOS (exits on any other OS) |
| 2 | Sources NVM + Homebrew paths (Apple Silicon & Intel) |
| 3 | Checks Node.js ≥ 18, installs via Homebrew if missing |
| 4 | Runs `npm install` only when needed (first run or package.json changed) |
| 5 | Checks Ollama / vLLM status, starts Ollama daemon if installed |
| 6 | Starts the backend server, polls `/api/health` until ready |
| 7 | Opens `http://localhost:3000` via macOS `open` command |

---

## AI Backend Setup

CoreLink 3D supports two AI backends: **Ollama** (default) and **vLLM**.

### Ollama (Recommended — easiest)

```bash
# Install
brew install ollama

# Pull a model (choose one)
ollama pull qwen2.5-coder:7b    # recommended
ollama pull llama3.2             # alternative
ollama pull qwen2.5:7b           # alternative

# Start daemon (start.command does this automatically)
ollama serve
```

### vLLM (Advanced — GPU recommended)

```bash
pip install vllm

# Start server
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-7B-Instruct \
  --host 0.0.0.0 --port 8000
```

Then launch with:
```bash
AI_BACKEND=vllm start.command
```

---

## Environment Variables

Set these before double-clicking `start.command` (via Terminal or a `.env`-style export):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `AI_BACKEND` | `ollama` | `ollama` or `vllm` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Model to use with Ollama |
| `VLLM_URL` | `http://localhost:8000` | vLLM API URL |
| `VLLM_MODEL` | `Qwen/Qwen2.5-Coder-7B-Instruct` | Model to use with vLLM |

---

## Project Structure

```
CoreLink3D/
├── start.command          ← macOS double-click launcher
├── package.json           ← All dependencies (locked versions)
├── README.md
├── Dockerfile
├── docker-compose.yml
├── server/
│   └── index.js           ← Express server: REST API + session management
├── public/
│   ├── app.html           ← Frontend (served dynamically — no index.html in root)
│   ├── css/
│   │   └── main.css       ← Total Black stylesheet
│   └── js/
│       ├── viewport.js    ← Three.js renderer (GLB/GLTF/DRACO/animations)
│       └── app.js         ← UI controller, sessions, chat, file management
└── uploads/               ← GLB/GLTF uploads (auto-created, gitignored)
```

---

## API Reference

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health, active backend, session count |
| GET | `/api/ai/status` | Ollama + vLLM online status and model availability |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/session` | Create new chat session |
| GET | `/api/session/:id` | Get session info + history |
| DELETE | `/api/session/:id` | Clear session history |
| GET | `/api/sessions` | List all active sessions |

### AI Chat

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/chat` | `{ prompt, sessionId?, stream? }` | Send message to AI |

### 3D Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/glb/upload` | Upload GLB/GLTF (multipart, field: `model`) |
| GET | `/api/glb/file/:name` | Stream a 3D file |
| GET | `/api/glb/list` | List uploaded files |
| DELETE | `/api/glb/file/:name` | Delete a file |

---

## Docker Deployment

```bash
# Build and start all services
docker compose up -d

# Pull AI model inside the Ollama container
docker exec ollama ollama pull qwen2.5-coder:7b

# View server logs
docker compose logs -f corelink3d
```

## Base Sepolia Donation E2E Test

The test sends real testnet USDC and requires a funded disposable wallet. It is
separate from the production Base donation address and refuses to run without
explicit test recipient and spender addresses.

```bash
export TEST_PRIVATE_KEY=0xYOUR_FUNDED_BASE_SEPOLIA_TEST_KEY
export TEST_RECIPIENT_ADDRESS=0xYOUR_TEST_RECIPIENT
export TEST_SPENDER_ADDRESS=0xYOUR_TEST_SPENDER
npm install
npm run test:donation
```

The wallet must hold Base Sepolia ETH for gas and Base Sepolia USDC at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The test prints both transaction
hashes, verifies the `Approval` and `Transfer` logs, and prints receipt status.

---

## Supported 3D Formats

- `.glb` — Binary glTF (recommended, single file)
- `.gltf` — JSON glTF

DRACO mesh compression is decoded automatically.
Files up to **500 MB** are accepted.

---

## Troubleshooting

**"start.command" is blocked by macOS Gatekeeper**
→ System Settings → Privacy & Security → Open Anyway

**Node.js not found even after Homebrew install**
→ Close Terminal, open it fresh, double-click start.command again

**AI shows "Offline"**
→ Run `ollama serve` in Terminal, then reload the page

**Model not found**
→ Run `ollama pull qwen2.5-coder:7b` in Terminal
