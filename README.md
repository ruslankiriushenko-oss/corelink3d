# CoreLink 3D

> 3D viewport editor with Blender-inspired dark theme.
> macOS only.

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
| 5 | Starts the backend server, polls `/api/health` until ready |
| 6 | Opens `http://localhost:3000` via macOS `open` command |

---

## Environment Variables

Set these before double-clicking `start.command` (via Terminal or a `.env`-style export):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |

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
│   └── index.js           ← Express server: REST API + file management
├── public/
│   ├── index.html         ← Main frontend
│   ├── app.html           ← Alternative frontend
│   ├── css/
│   │   └── main.css       ← Dark theme stylesheet
│   │   └── styles.css     ← Blender-inspired styles
│   └── js/
│       ├── viewport.js    ← Three.js renderer (GLB/GLTF/DRACO/animations)
│       ├── app.js         ← UI controller, file management
│       ├── ui.js          ← UI event bindings
│       ├── materialManager.js    ← Material properties
│       ├── environmentManager.js  ← Environment lighting
│       ├── modelInspector.js     ← Model analytics
│       ├── viewer3d.js           ← 3D viewport control
│       ├── webgpuEditor.js       ← WebGPU editor
│       ├── assetManager.js       ← Asset management
│       ├── projectBundle.js      ← Project save/load
│       ├── modelStorage.js      ← File storage
│       ├── modelValidation.js    ← File validation
│       └── donationManager.js   ← Donation feature
└── uploads/               ← GLB/GLTF uploads (auto-created, gitignored)
```

---

## API Reference

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health check |

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
- `.obj` — Wavefront OBJ
- `.fbx` — Autodesk FBX
- `.cl3d` — CoreLink 3D project bundle

DRACO mesh compression is decoded automatically.
Files up to **500 MB** are accepted.

---

## Troubleshooting

**"start.command" is blocked by macOS Gatekeeper**
→ System Settings → Privacy & Security → Open Anyway

**Node.js not found even after Homebrew install**
→ Close Terminal, open it fresh, double-click start.command again
