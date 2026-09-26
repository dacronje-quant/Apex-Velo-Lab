    class VeloFolderSync {
      constructor(app) {
        this.app = app;
        this.dirHandle = null;
      }

      async connectFolder(cleanSync = false) {
        if (!window.showDirectoryPicker) {
          this.app.showToast('Folder access needs Chrome, Edge or Opera. Use "Choose files" instead.', 'warning');
          return;
        }
        try {
          this.dirHandle = await window.showDirectoryPicker({ mode: 'read' });
          const statusEl = document.getElementById('folderSyncStatus');
          if (statusEl) {
            statusEl.hidden = false;
            statusEl.className = 'folder-sync-pill';
            statusEl.innerHTML = `${cleanSync ? 'Wiping & ' : ''}Scanning HealthFit Folder: <strong>${this.dirHandle.name}</strong>...`;
          }

          if (cleanSync) {
            this.app.completedWorkouts = [];
            try { localStorage.removeItem('apex_velo_history'); } catch(e) {}
            await VeloDB.clearAllRides();
          }

          let fitCount = 0;
          let newRides = 0;
          const existingFiles = new Set(this.app.completedWorkouts.map(r => r.fileName).filter(Boolean));

          for await (const entry of this.dirHandle.values()) {
            if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.fit') && /cycling/i.test(entry.name)) {
              fitCount++;
              try {
                const file = await entry.getFile();
                const buffer = await file.arrayBuffer();
                const ride = VeloRideImporter.parseFit(buffer, this.app.activeProfile.name, this.app.activeProfile.ftp);
                if (ride && !existingFiles.has(entry.name)) {
                  ride.fileName = entry.name;
                  ride.title = `HealthFit - ${entry.name.replace('.fit', '')}`;
                  this.app.completedWorkouts.unshift(ride);
                  existingFiles.add(entry.name);
                  newRides++;
                }
              } catch (parseErr) {
                console.warn('Error parsing fit file:', entry.name, parseErr);
              }
            }
          }

          await this.app.saveHistory();
          this.app.renderHistoryTable();
          this.app.recalculatePmc();
          this.app.renderCalendarView();
          this.app.updateMmpChart();
          this.app.refreshAnalytics && this.app.refreshAnalytics();
          this.app.updateHeroStats();

          if (statusEl) {
            statusEl.innerHTML = `Connected: <strong>${this.dirHandle.name}</strong> (${fitCount} FIT files, ${newRides} ${cleanSync ? 'synced fresh' : 'new imported'})`;
          }
          this.app.showToast(`Scanned HealthFit folder: ${cleanSync ? 'Cleanly replaced history with' : 'Imported'} ${newRides} cycling sessions!`);
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.error('Folder access error', err);
            this.app.showToast('Could not access folder: ' + err.message, 'error');
          }
        }
      }
    }

if (typeof window !== 'undefined') window.VeloFolderSync = VeloFolderSync;
