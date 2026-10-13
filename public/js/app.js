/**
 * CoreLink 3D — Main Application Orchestrator (app.js)
 * Initializes CoreLink 3D workspace, top dropdown menus,
 * property tabs, support/donation modal, and boots Babylon.js WebGPU engine.
 */

import { webgpuEditor } from './webgpuEditor.js';
import donationManager from './donationManager.js';

class AppController {
  init() {
    console.log('[CoreLink 3D] Starting CoreLink 3D Studio...');

    this.initSplashScreen();
    this.initMenus();
    this.initTabs();
    this.initModals();
    donationManager.init();

    // Boot Babylon 3D Engine immediately
    webgpuEditor.start();
  }

  initSplashScreen() {
    const splashScreen = document.getElementById('splashScreen');
    const newSessionBtn = document.getElementById('splashNewSession');
    const donateBtn = document.getElementById('splashDonate');
    const contactBtn = document.getElementById('splashContact');
    const aboutBtn = document.getElementById('splashAbout');

    if (!splashScreen) return;

    // Clear old session data on fresh install (localStorage check)
    const installVersion = localStorage.getItem('corelink-install-version');
    const currentVersion = '1.2.0';
    
    if (!installVersion) {
      // Fresh install - initialize clean session storage
      console.log('[CoreLink 3D] Fresh install detected...');
      indexedDB.deleteDatabase('corelink3d-storage');
      localStorage.removeItem('corelink-scene-backup');
      localStorage.setItem('corelink-install-version', currentVersion);
      // Flag to indicate fresh install - don't create default cube
      localStorage.setItem('corelink-fresh-install', 'true');
    } else if (installVersion !== currentVersion) {
      // Version upgrade - keep existing saved scenes and update version tag
      localStorage.setItem('corelink-install-version', currentVersion);
    }

    // Check if splash screen was already dismissed in session
    const hasShownSplash = sessionStorage.getItem('corelink-splash-shown');
    
    if (hasShownSplash) {
      document.documentElement.classList.add('splash-hidden');
      splashScreen.style.display = 'none';
      splashScreen.remove();
    }

    // New Session button - closes splash screen and enters clean workspace
    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', () => {
        sessionStorage.setItem('corelink-splash-shown', 'true');
        document.documentElement.classList.add('splash-hidden');
        splashScreen.classList.add('hidden');
        setTimeout(() => splashScreen.remove(), 300);
        if (webgpuEditor) {
          webgpuEditor.resetWorkspace();
        }
      });
    }

    // Donate button - triggers donation modal, keeps splash screen visible
    if (donateBtn) {
      donateBtn.addEventListener('click', () => {
        const donateModal = document.getElementById('donateModal');
        if (donateModal) {
          donateModal.classList.add('open');
          // Keep splash screen visible, don't hide it
        }
      });
    }

    // Contact button - triggers contact modal, keeps splash screen visible
    if (contactBtn) {
      contactBtn.addEventListener('click', () => {
        const contactModal = document.getElementById('contactModal');
        if (contactModal) {
          contactModal.classList.add('open');
          // Keep splash screen visible, don't hide it
        }
      });
    }

    // About button - triggers about modal, keeps splash screen visible
    if (aboutBtn) {
      aboutBtn.addEventListener('click', () => {
        const aboutModal = document.getElementById('aboutModal');
        if (aboutModal) {
          aboutModal.classList.add('open');
          // Keep splash screen visible, don't hide it
        }
      });
    }

    // When modals are closed, splash screen remains visible
    const modals = ['donateModal', 'contactModal', 'aboutModal'];
    modals.forEach(modalId => {
      const modal = document.getElementById(modalId);
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.classList.remove('open');
            // Splash screen stays visible
          }
        });
        const closeBtn = modal.querySelector('.b-modal-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            modal.classList.remove('open');
            // Splash screen stays visible
          });
        }
      }
    });
  }

  /**
   * Top Header Dropdown Menus
   */
  initMenus() {
    const menuItems = document.querySelectorAll('.b-menu-item');

    menuItems.forEach((item) => {
      const btn = item.querySelector('.b-menu-btn');
      if (!btn) return;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = item.classList.contains('open');
        this.closeAllMenus();
        if (!wasOpen) {
          item.classList.add('open');
        }
      });

      // Hover to switch open menu if another is already open
      item.addEventListener('mouseenter', () => {
        const anyOpen = document.querySelector('.b-menu-item.open');
        if (anyOpen && anyOpen !== item) {
          this.closeAllMenus();
          item.classList.add('open');
        }
      });
    });

    // Close menus when clicking anywhere else
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.b-menu-item')) {
        this.closeAllMenus();
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeAllMenus();
      }
    });
  }

  closeAllMenus() {
    document.querySelectorAll('.b-menu-item.open').forEach((m) => m.classList.remove('open'));
  }

  /**
   * Properties Panel Category Tabs (Object, Material)
   */
  initTabs() {
    const tabs = document.querySelectorAll('.b-prop-tab');
    const panes = document.querySelectorAll('.b-tab-pane');

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        if (!target) return;

        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');

        panes.forEach((pane) => {
          const isTarget = pane.id === `pane${target.charAt(0).toUpperCase() + target.slice(1)}`;
          pane.classList.toggle('active', isTarget);
        });
      });
    });
  }

  /**
   * Utility Modals (Donation, Contact, About, Shortcuts, Recycle Bin)
   */
  initModals() {
    const bindModal = (openBtnId, modalId, closeBtnId) => {
      const openBtn = document.getElementById(openBtnId);
      const modal = document.getElementById(modalId);
      const closeBtn = document.getElementById(closeBtnId);

      if (openBtn && modal) {
        openBtn.addEventListener('click', () => {
          modal.classList.add('open');
          this.closeAllMenus();
        });
      }
      if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => modal.classList.remove('open'));
      }
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.classList.remove('open');
        });
      }
    };

    // Project Menu -> Donate
    bindModal('btnMenuDonate', 'donateModal', 'donateModalClose');

    // Project Menu -> Contact
    bindModal('btnMenuContact', 'contactModal', 'contactModalClose');

    // Project Menu -> About
    bindModal('btnMenuAbout', 'aboutModal', 'aboutModalClose');

    // Help Menu -> Shortcuts
    bindModal('btnMenuShortcuts', 'shortcutsModal', 'shortcutsModalClose');

    // Asset Tab -> Recycle Bin
    bindModal('btnOpenTrash', 'trashModal', 'trashModalClose');

    // Copy email handler
    const btnCopyEmail = document.getElementById('btnCopyContactEmail');
    const contactFeedback = document.getElementById('contactCopyFeedback');
    if (btnCopyEmail && contactFeedback) {
      btnCopyEmail.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText('corelink3d@outlook.com');
          btnCopyEmail.textContent = 'Copied';
          contactFeedback.textContent = 'Email copied to clipboard';
        } catch {
          contactFeedback.textContent = 'Failed to copy';
        }
        setTimeout(() => {
          btnCopyEmail.textContent = 'Copy Email';
          contactFeedback.textContent = '';
        }, 2200);
      });
    }
  }
}

const appController = new AppController();
window.addEventListener('DOMContentLoaded', () => {
  appController.init();
});

export default appController;
