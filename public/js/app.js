/**
 * CoreLink 3D — Main Application Controller (app.js)
 * Initializes session management, AI status checks, backend toggle switches, and UI bindings.
 */

import viewer3d from './viewer3d.js';
import uiManager from './ui.js';
import donationManager from './donationManager.js';
import assetManager from './assetManager.js';

class AppController {
  constructor() {
    this.sessionId = null;
    this.currentBackend = 'ollama';
  }

  async init() {
    console.log('[CoreLink 3D] Initializing Studio App Controller...');

    // 1. Session Setup
    await this.initSession();

    // 2. Check Local AI Backend Status
    await this.checkAiStatus();
    setInterval(() => this.checkAiStatus(), 25000);

    // 3. Initialize UI Controller
    uiManager.init(this.sessionId);
    donationManager.init();

    if (!assetManager.getState().active.length) {
      assetManager.registerDemo('SciFi_Core_Demo.glb');
    }

    // 4. Backend Toggle Handlers
    this.bindBackendToggle();

    console.log('[CoreLink 3D] Studio initialized successfully.');
  }

  async initSession() {
    const sessionEl = document.getElementById('sessionId');
    try {
      const res = await fetch('/api/session', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.sessionId = data.sessionId;
      if (sessionEl) {
        sessionEl.textContent = data.sessionId.slice(0, 16) + '…';
      }
    } catch (err) {
      console.warn('[AppController] Session init failed, running standalone mode:', err.message);
      this.sessionId = 'standalone-' + Date.now();
      if (sessionEl) sessionEl.textContent = 'STANDALONE';
    }
  }

  async checkAiStatus() {
    const dot   = document.getElementById('statusDot');
    const label = document.getElementById('statusLabel');
    const model = document.getElementById('statusModel');

    if (dot) dot.className = 'status-dot loading';
    if (label) label.textContent = 'Checking AI...';

    try {
      const res  = await fetch('/api/ai/status');
      const data = await res.json();
      const active = data.active;

      if (active && active.online && active.modelAvailable) {
        if (dot) dot.className = 'status-dot online';
        if (label) label.textContent = 'AI ONLINE';
        if (model) model.textContent = active.targetModel;
      } else if (active && active.online) {
        if (dot) dot.className = 'status-dot loading';
        if (label) label.textContent = 'MODEL MISSING';
        if (model) model.textContent = `ollama pull ${active.targetModel}`;
      } else {
        if (dot) dot.className = 'status-dot offline';
        if (label) label.textContent = 'AI OFFLINE';
        if (model) model.textContent = data.backend === 'vllm' ? 'vLLM server down' : 'Ollama server down';
      }

      this.currentBackend = data.backend || 'ollama';

      // Sync Toggle Buttons
      document.querySelectorAll('.backend-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.backend === this.currentBackend);
      });

    } catch (err) {
      if (dot) dot.className = 'status-dot offline';
      if (label) label.textContent = 'SERVER DISCONNECTED';
      if (model) model.textContent = 'Offline';
    }
  }

  bindBackendToggle() {
    const btns = document.querySelectorAll('.backend-btn');
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentBackend = btn.dataset.backend;
        console.log(`[AppController] Switched active backend preference to: ${this.currentBackend}`);
      });
    });
  }
}

function boot() {
  const app = new AppController();
  app.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
