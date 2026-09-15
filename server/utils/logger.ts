export const logger = {
  info: (msg: string, meta?: any) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [INFO] ${msg}`, meta !== undefined ? meta : '');
  },
  warn: (msg: string, meta?: any) => {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [WARN] ${msg}`, meta !== undefined ? meta : '');
  },
  error: (msg: string, err?: any) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] [ERROR] ${msg}`, err !== undefined ? (err.stack || err.message || err) : '');
  },
  debug: (msg: string, meta?: any) => {
    if (process.env.DEBUG === 'true') {
      const ts = new Date().toISOString();
      console.debug(`[${ts}] [DEBUG] ${msg}`, meta !== undefined ? meta : '');
    }
  },
};
