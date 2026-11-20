/** Shared phone copy and enhancements for existing app controls; no desktop changes. */
export function workoutName(title) {
  const text = String(title || 'Workout').replace(/SweetSpot/gi, 'Sweet spot').replace(/VO2max/gi, 'VO₂ max');
  const parts = text.split(/\s+-\s+/);
  const name = parts.length === 2 && /sweet spot|threshold|endurance|VO₂|recovery/i.test(parts[1]) ? parts[1] : text;
  return name.replace(/(\d+)x(\d+)/g, '$1 × $2');
}

export function durationText(seconds) {
  const minutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

export function labelIntervalFields(doc) {
  const table = doc.querySelector('#customWorkoutTableSection .interval-table');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')].map((n) => n.textContent.trim());
  for (const row of table.querySelectorAll('tbody tr')) {
    [...row.cells].forEach((cell, i) => {
      cell.dataset.avLabel = i === 0 ? 'Step' : headers[i] || '';
      for (const input of cell.querySelectorAll('input, select')) {
        input.setAttribute('aria-label', `Step ${row.rowIndex}: ${headers[i] || 'value'}`);
        if (input.type === 'number') input.inputMode = input.step && input.step !== '1' ? 'decimal' : 'numeric';
      }
    });
  }
}

export function installUiPolish({ shell, win = window }) {
  const doc = win.document;
  const text = (id, value) => { const n = doc.getElementById(id); if (n) n.textContent = value; };
  shell.whenApp(() => {
    const app = shell.getApp();
    // Native profile editing reports invalid values instead of silently clamping them.
    const saveProfile = app.saveProfileFromInputs.bind(app);
    app.saveProfileFromInputs = (...args) => {
      let invalid = null;
      for (const id of ['profInputFtp', 'profInputWeight', 'profInputMaxHr', 'profInputCrank', 'profInputLthr']) {
        const input = doc.getElementById(id);
        if (!input) continue;
        input.setCustomValidity('');
        if (id === 'profInputLthr' && input.value && Number(input.value) >= Number(doc.getElementById('profInputMaxHr').value)) input.setCustomValidity('Threshold heart rate must be below maximum heart rate.');
        const valid = input.checkValidity();
        input.setAttribute('aria-invalid', String(!valid));
        let error = doc.getElementById(id + 'Error');
        if (!error) { error = doc.createElement('p'); error.id = id + 'Error'; error.className = 'av-field-error'; input.after(error); input.setAttribute('aria-describedby', error.id); }
        error.hidden = valid;
        error.textContent = valid ? '' : input.validity.customError ? input.validationMessage : `Enter a value from ${input.min} to ${input.max}${input.step && input.step !== '1' ? ` in steps of ${input.step}` : ''}.`;
        if (!valid && !invalid) invalid = input;
      }
      if (invalid) { const more = invalid.closest('details'); if (more) more.open = true; invalid.focus(); return; }
      return saveProfile(...args);
    };
    for (const [id, min, max, step] of [['profInputFtp',50,700,1], ['profInputWeight',30,200,.1], ['profInputMaxHr',100,230,1]]) {
      const n = doc.getElementById(id);
      if (n) { n.min = min; n.max = max; n.step = step; n.required = true; }
    }
    // Let the original table create and bind every input, then apply phone labels to the live nodes.
    if (app.populateCustomIntervalTable) {
      const render = app.populateCustomIntervalTable.bind(app);
      app.populateCustomIntervalTable = (...args) => { const result = render(...args); labelIntervalFields(doc); return result; };
    }
    // Keep one transient success/info message instead of covering the navigation with a stack.
    const toast = app.showToast.bind(app);
    app.showToast = (message, type = 'info', ...args) => {
      if (type === 'info' || type === 'success') doc.querySelectorAll('.toast-info, .toast-success').forEach((n) => n.remove());
      return toast(message, type, ...args);
    };
    text('btnSaveCustomAsPreset', 'Save workout');
    text('btnAskEngineWarn', 'Set up AI coach');
    text('btnNativeIcuSave', 'Save and sync');
    text('btnNativeIcuBackfill', 'Sync full history');
    const describe = doc.querySelector('#historyDropzone p');
    if (describe) describe.textContent = 'Choose ride files from your phone, or a JSON backup to restore.';
    const folder = doc.getElementById('btnConnectHealthFitFolder')?.closest('.import-row');
    if (folder) folder.hidden = true;
    const importRows = doc.querySelector('#importSyncCard .import-rows');
    const bulkRow = doc.querySelector('.bulk-import-row');
    if (importRows && bulkRow) {
      importRows.prepend(bulkRow);
      const dropzone = doc.getElementById('historyDropzone');
      if (dropzone) {
        const section = doc.createElement('div'); section.className = 'av-backup-import';
        dropzone.before(section); section.appendChild(dropzone);
        const title = dropzone.querySelector('h4'); if (title) title.textContent = 'JSON backup';
        const explanation = dropzone.querySelector('p'); if (explanation) explanation.textContent = 'Restore rides and settings from a JSON backup.';
        text('btnChooseImportFiles', 'Choose backup');
        const fileInput = doc.getElementById('fileInputTcx'); if (fileInput) fileInput.accept = '.json,.gz';
      }
      const title = bulkRow.querySelector('h4'); if (title) title.textContent = 'Import rides';
      text('btnImportHistory', 'Choose files');
    }
    const shortHelp = (selector, value) => { const n = doc.querySelector(selector); if (n) n.textContent = value; };
    shortHelp('#nativeImportSettings > .field-help', 'Pick a folder where ride files arrive, such as Dropbox, Google Drive or a Garmin, Wahoo or Karoo export folder. New rides there are imported automatically; each file only once.');
    shortHelp('#nativeFileSettings > .field-help', 'Ride files are saved to Documents/ApexVelo on this phone, where Garmin Connect, TrainingPeaks, intervals.icu and file managers can open them.');
    const bulk = doc.querySelector('.bulk-import-row .dim');
    if (bulk) bulk.textContent = 'Choose ride files or a Garmin or Strava export ZIP. Duplicates are skipped.';
    for (const id of ['coachReadinessChip', 'cockpitReadinessChip', 'anaReadinessChip']) {
      const n = doc.getElementById(id);
      if (!n) continue;
      n.setAttribute('role','button'); n.tabIndex = 0;
      n.setAttribute('aria-label','View recovery details');
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); n.click(); } });
    }
    for (const link of doc.querySelectorAll('a[href^="docs/"]')) {
      if (/privacy/i.test(link.textContent)) {
        link.href = 'https://github.com/dacronje-quant/Apex-Velo-Lab/blob/claude/android-apk-poc/mobile/PRIVACY.md';
        continue;
      }
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'av-text-action';
      button.textContent = 'Help & about';
      button.addEventListener('click', () => shell.go('you/help'));
      link.replaceWith(button);
    }
    const context = doc.querySelector('#view-ai-coach .section-sub');
    if (context) context.textContent = 'Uses your riding history. The built-in coach works without an AI key.';
    for (const [key, description] of [['ftp','Improve sustained power'], ['longevity','Build endurance'], ['vo2','Improve high-intensity fitness'], ['balanced','A mix of easy and hard rides']]) {
      const el = doc.querySelector(`#aiCoachGoalPills [data-goal="${key}"] small`); if (el) el.textContent = description;
    }
    const focus = doc.querySelector('#selectAiCoachFocus option[value=auto]'); if (focus) focus.textContent = 'Auto · based on your training';
    // Few hidden menus on the phone: short option groups are shown open, without their disclosure row.
    for (const details of doc.querySelectorAll('#view-ai-coach details.coach-more')) { details.open = true; details.classList.add('av-open'); }
    const hcIntro = doc.querySelector('#nativeHc > .field-help');
    if (hcIntro) hcIntro.textContent = 'Choose which recovery data and rides Apex Velo can read or save.';
    const groupLabels = { recovery: 'Allow recovery data', rides: 'Allow ride imports', write: 'Allow saving rides' };
    for (const [key, label] of Object.entries(groupLabels)) doc.querySelector(`[data-hc-request="${key}"]`)?.replaceChildren(label);
    const sourceTitle = [...doc.querySelectorAll('#nativeHc h4')].find((n) => /both have a day/.test(n.textContent));
    if (sourceTitle) sourceTitle.textContent = 'Preferred data source';
    const fieldHelp = doc.querySelector('#nativeAiKeys > .field-help');
    if (fieldHelp) fieldHelp.textContent = 'Use your own API key. Your provider charges for usage. The built-in workout coach works without a key.';
    const keyPrivacy = [...doc.querySelectorAll('#nativeAiKeys > .field-help')].at(-1);
    if (keyPrivacy && keyPrivacy !== fieldHelp) keyPrivacy.textContent = 'Keys stay on this phone and go only to their provider. Backups exclude keys.';
    for (const el of doc.querySelectorAll('.form-group input[type=number]')) el.inputMode = el.step && el.step !== '1' ? 'decimal' : 'numeric';
  });
  shell.onRoute(({ route }) => {
    if (route === 'train/builder') labelIntervalFields(doc);
    if (route === 'you/profile') {
      text('profileFormHeaderTitle', 'Edit profile'); text('btnCancelEditProfile', 'Cancel'); text('btnSaveNewProfile', 'Save changes');
      const cancel = doc.getElementById('btnCancelEditProfile');
      if (cancel && !cancel.dataset.avCancel) { cancel.dataset.avCancel = '1'; cancel.addEventListener('click', () => shell.go('you')); }
    }
  });
}
