import cron, { type ScheduledTask } from 'node-cron';
import type { AutomationEngine } from './engine.js';

export function startScheduler(engine: AutomationEngine): ScheduledTask[] {
  const expressions = ['0 9 * * *', '0 11 * * *', '30 17 * * *'];
  return expressions.map((expression) => cron.schedule(expression, async () => {
    try {
      const settings = await engine.settings();
      if (settings.enabled && await engine.store.exists()) await engine.run('scheduled');
    } catch (error) {
      console.error('Scheduled tracking run failed:', error);
    }
  }, { timezone: 'Asia/Shanghai' }));
}
