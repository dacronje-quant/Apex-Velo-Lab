// Optional private archive. New clones receive null; the server never exposes the file to the LAN.
(function () {
  window.APEX_LOCAL_HISTORY = null;
  window.loadLocalHistory = async function () {
    if (window.__APEX_DEMO_MODE__ || (window.__APEX_TEST_MODE__ && new URLSearchParams(location.search).get('apexFixture') === '1')) {
      window.APEX_LOCAL_HISTORY = VeloDemo.history();
      return;
    }
    if (window.__APEX_TEST_MODE__) return;
    try {
      const r = await fetch('api/local-history', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Archive ${r.status}`);
      const data = await r.json();
      if (data && Array.isArray(data.rides)) window.APEX_LOCAL_HISTORY = data;
    } catch (e) {
      window.__APEX_ARCHIVE_ERROR__ = 'Could not load the optional local archive. Your browser rides are unchanged.';
    }
  };
})();
