/**
 * APEX VELO // LAB - Share card dialog (ride summary > Share card).
 * Draws the ride as an image with VeloShareCard and hands it to the system share
 * sheet (Strava, Instagram, messages) or downloads it. Strava's API cannot
 * attach photos, so the image goes through the share sheet or the Strava app.
 */
(function () {
  const STYLE_KEY = 'apex_share_card_style';

  Object.assign(VeloApp.prototype, {
    canShareCard(record) {
      return !!(window.VeloShareCard && VeloShareCard.canRender(record) && (!window.VeloMetrics?.isCycling || VeloMetrics.isCycling(record)));
    },

    bindShareCard() {
      if (this._shareCardBound) return;
      this._shareCardBound = true;
      this.on(this.$('btnCloseShareCard'), 'click', () => this.closeShareCard());
      this.on(this.$('shareCardModal'), 'click', (e) => { if (e.target.id === 'shareCardModal') this.closeShareCard(); });
      document.querySelectorAll('#shareCardModal [data-card-style]').forEach(b => this.on(b, 'click', () => {
        this._shareCardStyle = b.dataset.cardStyle;
        try { localStorage.setItem(STYLE_KEY, this._shareCardStyle); } catch (e) { /* storage blocked */ }
        this.renderShareCard();
      }));
      this.on(this.$('btnShareCard'), 'click', () => this.shareCardNow());
    },

    openShareCard(record) {
      if (!record || !this.canShareCard(record)) return this.showToast('This ride has no recorded power to draw a card from.', 'info');
      this.bindShareCard();
      this._shareCardRecord = record;
      if (!this._shareCardStyle) {
        try { this._shareCardStyle = localStorage.getItem(STYLE_KEY) || 'full'; } catch (e) { this._shareCardStyle = 'full'; }
      }
      const shareable = this.shareCardCanUseShareSheet();
      this.$('btnShareCard').hidden = !shareable;
      this.setText('shareCardHint', shareable
        ? 'Share opens your device\'s share sheet: choose Strava to post the card or add it to this ride.'
        : 'Download the image, then add it to this ride on Strava (open the activity and choose Add photos).');
      this.openModal('shareCardModal');
      this.renderShareCard();
    },

    closeShareCard() {
      this.closeModal('shareCardModal');
      this._shareCardToken = (this._shareCardToken || 0) + 1;
    },

    shareCardCanUseShareSheet() {
      try {
        return !!(window.isSecureContext && navigator.canShare && window.File
          && navigator.canShare({ files: [new File([new Uint8Array([255, 216, 255])], 'probe.jpg', { type: VeloShareCard.MIME })] }));
      } catch (e) { return false; }
    },

    async renderShareCard() {
      const record = this._shareCardRecord;
      if (!record) return;
      const style = VeloShareCard.STYLES.includes(this._shareCardStyle) ? this._shareCardStyle : 'full';
      document.querySelectorAll('#shareCardModal [data-card-style]').forEach(b => {
        const on = b.dataset.cardStyle === style;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      const token = this._shareCardToken = (this._shareCardToken || 0) + 1;
      const img = this.$('shareCardImg'), dl = this.$('btnDownloadCard'), share = this.$('btnShareCard');
      this.$('shareCardPreview').classList.add('busy');
      dl.classList.add('disabled'); share.disabled = true;
      try {
        const blob = await VeloShareCard.toBlob(record, { style });
        if (token !== this._shareCardToken) return; // style switched or dialog closed meanwhile
        if (this._shareCardUrl) URL.revokeObjectURL(this._shareCardUrl);
        this._shareCardUrl = URL.createObjectURL(blob);
        this._shareCardBlob = blob;
        this._shareCardName = VeloShareCard.fileName(record, style);
        img.src = this._shareCardUrl;
        img.alt = `${record.title || 'Ride'} summary card`;
        dl.href = this._shareCardUrl;
        dl.download = this._shareCardName;
        dl.classList.remove('disabled'); share.disabled = false;
      } catch (e) {
        if (token === this._shareCardToken) this.showToast('Could not draw the share card in this browser.', 'error');
      } finally {
        if (token === this._shareCardToken) this.$('shareCardPreview').classList.remove('busy');
      }
    },

    async shareCardNow() {
      if (!this._shareCardBlob) return;
      const file = new File([this._shareCardBlob], this._shareCardName, { type: this._shareCardBlob.type || VeloShareCard.MIME });
      try {
        if (!navigator.canShare || !navigator.canShare({ files: [file] })) throw new Error('unsupported');
        await navigator.share({ files: [file], title: this._shareCardRecord?.title || 'Ride' });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // the rider closed the share sheet
        this.$('btnDownloadCard').click();
        this.showToast('Sharing is not available here, so the card was downloaded instead.', 'info');
      }
    },
  });
})();
