    class VeloFolderSync {
      constructor(app) {
        this.app = app;
        this.dirHandle = null;
      }

      /** Reads every cycling FIT file in the folder. Nothing in history is touched. */
      async scanFolder(dirHandle) {
        const rides = [];
        let fitCount = 0;
        for await (const entry of dirHandle.values()) {
          if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.fit') || !/cycling/i.test(entry.name)) continue;
          fitCount++;
          try {
            const file = await entry.getFile();
            const ride = VeloRideImporter.parseFit(await file.arrayBuffer(), this.app.activeProfile.name, this.app.activeProfile.ftp);
            if (ride) {
              ride.fileName = entry.name;
              ride.title = `HealthFit - ${entry.name.replace('.fit', '')}`;
              rides.push(ride);
            }
          } catch (parseErr) {
            console.warn('Error parsing fit file:', entry.name, parseErr);
          }
        }
        return { rides, fitCount };
      }

      async connectFolder(cleanSync = false) {
        if (!window.showDirectoryPicker) {
          this.app.showToast('Folder access needs Chrome, Edge or Opera. Use "Choose files" instead.', 'warning');
          return;
        }
        const statusEl = document.getElementById('folderSyncStatus');
        const setStatus = (html) => { if (statusEl) { statusEl.hidden = false; statusEl.className = 'folder-sync-pill'; statusEl.innerHTML = html; } };
        const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        try {
          this.dirHandle = await window.showDirectoryPicker({ mode: 'read' });
          const folder = esc(this.dirHandle.name);
          setStatus(`Scanning HealthFit Folder: <strong>${folder}</strong>...`);
          const { rides, fitCount } = await this.scanFolder(this.dirHandle);

          let added;
          if (cleanSync) {
            // Replacing history is only done with a readable folder, the rider's consent and a restore point.
            const current = this.app.completedWorkouts.length;
            if (!rides.length) {
              setStatus(`No cycling rides found in <strong>${folder}</strong>. History was not changed.`);
              this.app.showToast(`No cycling FIT files could be read in "${this.dirHandle.name}". Your history was not changed.`, 'warning');
              return;
            }
            const backup = window.VeloStorage?.enabled;
            if (!confirm(`Replace all ${current} rides in your history with the ${rides.length} rides found in "${this.dirHandle.name}"?\n\n`
              + (backup ? 'A restore point is saved first (Settings > Backups).' : 'No local server is running, so no restore point can be made: use Backup JSON first if you may want your current history back.'))) {
              setStatus(`Not replaced: <strong>${folder}</strong> (${fitCount} FIT files). History was not changed.`);
              return;
            }
            if (backup) {
              try { await VeloStorage.request('/backup', {}); }
              catch (e) { this.app.showToast(`Could not save a restore point (${e.message}). History was not changed.`, 'error'); setStatus(`Not replaced: restore point failed. History was not changed.`); return; }
            }
            // One change replaces everything: either all of it is saved or none of it.
            const previous = this.app.completedWorkouts.map(r => r.id).filter(id => !rides.some(n => n.id === id));
            if (!await VeloDB.applyRideChanges(rides, previous, { exact: true })) {
              this.app.showToast('Could not replace the saved history. Your workouts are unchanged.', 'error');
              setStatus(`Not replaced: saving failed. History was not changed.`);
              return;
            }
            this.app.completedWorkouts = rides;
            added = rides.length;
          } else {
            const existingFiles = new Set(this.app.completedWorkouts.map(r => r.fileName).filter(Boolean));
            const fresh = rides.filter(r => !existingFiles.has(r.fileName));
            this.app.completedWorkouts.unshift(...fresh.reverse());
            added = fresh.length;
          }

          await this.app.saveHistory();
          this.app.renderHistoryTable();
          this.app.recalculatePmc();
          this.app.renderCalendarView();
          this.app.updateMmpChart();
          this.app.refreshAnalytics && this.app.refreshAnalytics();
          this.app.updateHeroStats();

          setStatus(`Connected: <strong>${folder}</strong> (${fitCount} FIT files, ${added} ${cleanSync ? 'synced fresh' : 'new imported'})`);
          this.app.showToast(`Scanned HealthFit folder: ${cleanSync ? 'Replaced history with' : 'Imported'} ${added} cycling sessions!`);
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.error('Folder access error', err);
            this.app.showToast('Could not access folder: ' + err.message, 'error');
          }
        }
      }
    }

if (typeof window !== 'undefined') window.VeloFolderSync = VeloFolderSync;
