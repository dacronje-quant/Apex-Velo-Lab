module.exports = { headless: true,
  ...(process.env.APEX_BROWSER_CHANNEL ? { channel: process.env.APEX_BROWSER_CHANNEL }
    : process.platform === 'win32' ? { channel: 'msedge' } : {}) };
