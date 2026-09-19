import type { AlertLevel, AlertSink } from '../../core/provider/alerts/index.js';

/** console alert sink — writes to console.warn/console.error by severity */
export function createConsoleAlertSink(): AlertSink {
  return {
    async alert(level: AlertLevel, message: string, meta?: Record<string, unknown>) {
      const line = meta === undefined ? message : `${message} ${JSON.stringify(meta)}`;
      if (level === 'error') {
        console.error(`[weavekit:alert:error] ${line}`);
      } else {
        console.warn(`[weavekit:alert:warn] ${line}`);
      }
    },
  };
}
