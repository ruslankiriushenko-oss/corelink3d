#!/bin/bash
# =============================================================
#  CoreLink 3D — macOS Launcher
#  Double-click this file in Finder to launch the app.
#  macOS ONLY. No Windows/Linux support.
# =============================================================

# Do NOT use set -e: grep, lsof, ollama return non-zero
# legitimately and would abort the script prematurely.
set -uo pipefail

# ── ANSI colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m'

# ── Move to the directory containing this script ─────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

clear
echo ""
echo -e "${WHITE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${WHITE}║           CoreLink 3D  v1.1.0                ║${NC}"
echo -e "${WHITE}║     3D Viewport Editor for macOS           ║${NC}"
echo -e "${WHITE}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── macOS guard ──────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}ERROR: This launcher is macOS only.${NC}"
  read -r -p "Press Enter to exit..."
  exit 1
fi

MACOS_VER="$(sw_vers -productVersion)"
ARCH="$(uname -m)"
echo -e "${DIM}Platform : macOS ${MACOS_VER} | ${ARCH}${NC}"
echo ""

# =============================================================
# STEP 1 — Node.js
# =============================================================
echo -e "${CYAN}[1/4] Checking Node.js...${NC}"

# Source NVM if present (common on developer machines)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh" --no-use 2>/dev/null || true
fi

# Add Homebrew to PATH — Apple Silicon uses /opt/homebrew, Intel uses /usr/local
for BREW_BIN in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in
    *":$BREW_BIN:"*) ;;
    *) export PATH="$BREW_BIN:$PATH" ;;
  esac
done

# Also add common nvm node paths
for NVM_NODE in "$NVM_DIR/versions/node"/*/bin; do
  [ -d "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
done

if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}Node.js not found. Attempting install via Homebrew...${NC}"

  if ! command -v brew &>/dev/null; then
    echo -e "${RED}Homebrew not installed.${NC}"
    echo -e "Install it first, then double-click start.command again:"
    echo -e "  ${WHITE}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${NC}"
    echo ""
    read -r -p "Press Enter to exit..."
    exit 1
  fi

  echo -e "${YELLOW}Running: brew install node ...${NC}"
  brew install node
  echo -e "${GREEN}Node.js installed via Homebrew.${NC}"
fi

NODE_VER="$(node -v)"
NPM_VER="$(npm -v)"
echo -e "${GREEN}✓ Node.js ${NODE_VER}  /  npm ${NPM_VER}${NC}"

# Verify minimum version (>=18)
NODE_MAJOR="$(node -e 'process.stdout.write(process.version.split(".")[0].slice(1))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${RED}Node.js 18+ is required (found ${NODE_VER}).${NC}"
  echo -e "Run: ${WHITE}brew upgrade node${NC}"
  read -r -p "Press Enter to exit..."
  exit 1
fi

# =============================================================
# STEP 2 — npm dependencies
# =============================================================
echo -e "${CYAN}[2/3] Checking dependencies...${NC}"

NEEDS_INSTALL=false
if [ ! -d "node_modules" ]; then
  NEEDS_INSTALL=true
elif [ ! -f "node_modules/.install_ok" ]; then
  NEEDS_INSTALL=true
elif [ "package.json" -nt "node_modules/.install_ok" ]; then
  # package.json is newer than the last install marker
  echo -e "${YELLOW}package.json changed — reinstalling dependencies...${NC}"
  NEEDS_INSTALL=true
fi

if $NEEDS_INSTALL; then
  echo -e "${YELLOW}Installing npm packages (this happens only once)...${NC}"
  npm install 2>&1 | grep -E "^(added|found|npm (WARN|ERR))" || true
  touch node_modules/.install_ok
  echo -e "${GREEN}✓ Dependencies installed${NC}"
else
  echo -e "${GREEN}✓ Dependencies already up to date${NC}"
fi

# =============================================================
# STEP 3 — Start server & open browser
# =============================================================
echo -e "${CYAN}[3/3] Starting CoreLink 3D server...${NC}"
echo ""

PORT="${PORT:-3000}"
HOST="http://localhost:${PORT}"

# If port is in use, try the next one
ORIG_PORT="${PORT}"
if lsof -i ":${PORT}" &>/dev/null 2>&1; then
  PORT=$((PORT + 1))
  HOST="http://localhost:${PORT}"
  echo -e "${YELLOW}Port ${ORIG_PORT} is in use — switching to ${PORT}${NC}"
fi

export PORT

# Launch server in background
node server/index.js &
SERVER_PID=$!

# Poll /api/health until ready (up to 20 seconds)
echo -e "${DIM}Waiting for server to start...${NC}"
MAX_WAIT=20
COUNT=0
until curl -sf "${HOST}/api/health" &>/dev/null; do
  sleep 0.5
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -ge $((MAX_WAIT * 2)) ]; then
    echo -e "${RED}✗ Server failed to start within ${MAX_WAIT} seconds.${NC}"
    kill "$SERVER_PID" 2>/dev/null
    read -r -p "Press Enter to exit..."
    exit 1
  fi
done

echo -e "${GREEN}✓ Server is ready${NC}"
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         CoreLink 3D is running!              ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║   Open : ${HOST}                 ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║   Press Ctrl+C to stop the server.           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Open browser using macOS native command
open "$HOST"

# Graceful shutdown handler
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down CoreLink 3D...${NC}"
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  echo -e "${GREEN}Stopped. Goodbye.${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for server process (keeps Terminal window open)
wait "$SERVER_PID"
