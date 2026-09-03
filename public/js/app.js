/**
 * CoreLink 3D — Main Application Controller (app.js)
 * Initializes session management, AI status checks, backend toggle switches, and UI bindings.
 */

import viewer3d from './viewer3d.js';
import uiManager from './ui.js';
import donationManager from './donationManager.js';
import assetManager from './assetManager.js';
import { getSavedModelFile } from './modelStorage.js';

class AppController {
  constructor() {
    this.sessionId = null;
    this.currentBackend = 'ollama';
    this.setupGlobalErrorHandlers();
    this.requestThrottleMap = new Map();
  }

  setupGlobalErrorHandlers() {
    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      console.error('[AppController] Unhandled Promise Rejection:', event.reason);
      event.preventDefault();
    });

    // Handle runtime errors gracefully
    window.addEventListener('error', (event) => {
      console.error('[AppController] Runtime Error:', event.error);
    });
  }

  isRequestThrottled(key, delayMs = 1000) {
    const now = Date.now();
    const lastTime = this.requestThrottleMap.get(key) || 0;
    if (now - lastTime < delayMs) {
      return true;
    }
    this.requestThrottleMap.set(key, now);
    return false;
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
    this.initModals();

    await this.restoreSavedModelOrDemo();

    // 4. Backend Toggle Handlers
    this.bindBackendToggle();

    console.log('[CoreLink 3D] Studio initialized successfully.');
  }

  initModals() {
    // Contact Modal
    const contactModal = document.getElementById('contactModal');
    const btnContact = document.getElementById('btnContact');
    const btnMobileContact = document.getElementById('btnMobileContact');
    const btnContactClose = document.getElementById('contactModalClose');
    const btnCopyEmail = document.getElementById('btnCopyContactEmail');
    const contactFeedback = document.getElementById('contactCopyFeedback');

    const openContactModal = () => {
      contactModal.classList.add('open');
      this.closeMobileMenu();
    };

    if (btnContact && contactModal) {
      btnContact.addEventListener('click', openContactModal);
    }
    if (btnMobileContact && contactModal) {
      btnMobileContact.addEventListener('click', openContactModal);
    }
    if (btnContactClose && contactModal) {
      btnContactClose.addEventListener('click', () => contactModal.classList.remove('open'));
      contactModal.addEventListener('click', (event) => {
        if (event.target === contactModal) contactModal.classList.remove('open');
      });
    }
    if (btnCopyEmail) {
      btnCopyEmail.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText('ruslankiriushenko@gmail.com');
          btnCopyEmail.textContent = 'Copied';
          btnCopyEmail.classList.add('copied');
          contactFeedback.textContent = 'Email copied to clipboard';
        } catch {
          contactFeedback.textContent = 'Copy failed - select the email manually';
        }
        window.setTimeout(() => {
          btnCopyEmail.textContent = 'Copy Email';
          btnCopyEmail.classList.remove('copied');
          contactFeedback.textContent = '';
        }, 2200);
      });
    }

    // About Modal
    const aboutModal = document.getElementById('aboutModal');
    const btnAbout = document.getElementById('btnAbout');
    const btnMobileAbout = document.getElementById('btnMobileAbout');
    const btnAboutClose = document.getElementById('aboutModalClose');

    const openAboutModal = () => {
      aboutModal.classList.add('open');
      this.closeMobileMenu();
    };

    if (btnAbout && aboutModal) {
      btnAbout.addEventListener('click', openAboutModal);
    }
    if (btnMobileAbout && aboutModal) {
      btnMobileAbout.addEventListener('click', openAboutModal);
    }
    if (btnAboutClose && aboutModal) {
      btnAboutClose.addEventListener('click', () => aboutModal.classList.remove('open'));
      aboutModal.addEventListener('click', (event) => {
        if (event.target === aboutModal) aboutModal.classList.remove('open');
      });
    }

    // Mobile Donate Button
    const donateModal = document.getElementById('donateModal');
    const btnMobileDonate = document.getElementById('btnMobileDonate');
    if (btnMobileDonate && donateModal) {
      btnMobileDonate.addEventListener('click', () => {
        donateModal.classList.add('open');
        this.closeMobileMenu();
      });
    }

    // Mobile Menu Toggle
    this.initMobileMenu();
  }

  initMobileMenu() {
    const btnMobileMenu = document.getElementById('btnMobileMenu');
    const mobileMenuDrawer = document.getElementById('mobileMenuDrawer');

    if (btnMobileMenu && mobileMenuDrawer) {
      btnMobileMenu.addEventListener('click', () => {
        mobileMenuDrawer.classList.toggle('open');
      });
    }

    // Close menu when clicking outside
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.btn-mobile-menu') && !event.target.closest('.mobile-menu-drawer')) {
        this.closeMobileMenu();
      }
    });

    // Close menu when pressing Escape
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeMobileMenu();
      }
    });
  }

  closeMobileMenu() {
    const mobileMenuDrawer = document.getElementById('mobileMenuDrawer');
    if (mobileMenuDrawer) {
      mobileMenuDrawer.classList.remove('open');
    }
  }


  async restoreSavedModelOrDemo() {
    try {
      const savedModel = await getSavedModelFile();
      if (savedModel?.blob) {
        await viewer3d.loadModelFromFile(savedModel.blob);
        assetManager.registerUpload(savedModel.name, null);
        return;
      }
    } catch (error) {
      console.warn('[AppController] Saved model restore failed, loading demo:', error.message);
    }
    if (!assetManager.getState().active.length) assetManager.registerDemo('SciFi_Core_Demo.glb');
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
