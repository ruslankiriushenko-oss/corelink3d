/**
 * CoreLink 3D - Direct wallet donation UI.
 * The app never connects to a wallet or initiates a transaction.
 */

const RECIPIENT_ADDRESS = '0x3c93728119510665AA6d916Fd95e92330D7d0850';
const QR_DATA = `ethereum:${RECIPIENT_ADDRESS}`;
const QR_SERVICE = 'https://api.qrserver.com/v1/create-qr-code/';

class DonationManager {
  init() {
    const modal = document.getElementById('donateModal');
    const openButton = document.getElementById('btnDonate');
    const closeButton = document.getElementById('donateModalClose');
    const copyButton = document.getElementById('btnCopyDonateAddress');
    const addressElement = document.getElementById('donateRecipientAddress');
    const feedbackElement = document.getElementById('donateCopyFeedback');
    const qrElement = document.getElementById('donateQrCode');

    if (openButton && modal) {
      openButton.addEventListener('click', () => modal.classList.add('open'));
    }
    if (closeButton && modal) {
      closeButton.addEventListener('click', () => modal.classList.remove('open'));
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('open');
      });
    }

    if (qrElement) {
      this.renderQrCode(qrElement);
    }

    if (copyButton && addressElement && feedbackElement) {
      copyButton.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(RECIPIENT_ADDRESS);
          copyButton.textContent = 'Copied';
          copyButton.classList.add('copied');
          feedbackElement.textContent = 'Address copied';
        } catch {
          feedbackElement.textContent = 'Copy failed - select the address manually';
        }
        window.setTimeout(() => {
          copyButton.textContent = 'Copy Address';
          copyButton.classList.remove('copied');
          feedbackElement.textContent = '';
        }, 2200);
      });
    }
  }

  renderQrCode(qrElement) {
    if (window.QRCode && typeof window.QRCode.toDataURL === 'function') {
      window.QRCode.toDataURL(QR_DATA, {
        margin: 1,
        width: 288,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      }, (err, url) => {
        if (!err && url) {
          qrElement.src = url;
          return;
        }
        this.fallbackQr(qrElement);
      });
    } else {
      this.fallbackQr(qrElement);
    }
  }

  fallbackQr(qrElement) {
    const encodedData = encodeURIComponent(QR_DATA);
    qrElement.src = `${QR_SERVICE}?size=288x288&data=${encodedData}`;
  }
}

const donationManager = new DonationManager();
export default donationManager;
