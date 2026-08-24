import cron, { type ScheduledTask } from 'node-cron';
import type { AutomationEngine } from './engine.js';

function shanghaiMinute(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export function startScheduler(engine: AutomationEngine, listEngines: () => AutomationEngine[] = () => [engine]): ScheduledTask[] {
  const executedTaskKeys = new Set<string>();
  const executedCleanupKeys = new Set<string>();
  const customTask = cron.schedule('* * * * *', async () => {
    const current = shanghaiMinute(new Date());
    for (const key of executedTaskKeys) if (!key.startsWith(current.date)) executedTaskKeys.delete(key);
    for (const key of executedCleanupKeys) if (!key.includes(`:${current.date}:`)) executedCleanupKeys.delete(key);
    for (const target of listEngines()) {
      try {
        const cleanupKey = `${target.store.dataDirectory}:${current.date}:clearance-history`;
        if (!executedCleanupKeys.has(cleanupKey)) {
          executedCleanupKeys.add(cleanupKey);
          await target.cleanupClearanceHistory().catch((error) => {
            executedCleanupKeys.delete(cleanupKey);
            console.error('Clearance history cleanup failed:', error);
          });
        }
        const settings = await target.settings();
        if (!settings.enabled || !(await target.store.exists())) continue;
        const tasks = await target.listTasks();
        for (const task of tasks) {
          const taskKey = `${target.store.dataDirectory}:${current.date}:${task.id}`;
          const lastRun = task.lastRunAt ? shanghaiMinute(new Date(task.lastRunAt)) : null;
          const alreadyRanToday = lastRun?.date === current.date && lastRun.time === task.scheduleTime;
          if (task.enabled && task.scheduleTime === current.time && !alreadyRanToday && !executedTaskKeys.has(taskKey)) {
            executedTaskKeys.add(taskKey);
            try {
              await target.runTask(task.id);
            } catch (error) {
              executedTaskKeys.delete(taskKey);
              console.error(`Custom scheduled task ${task.id} failed:`, error);
            }
          }
        }
      } catch (error) {
        console.error('Custom scheduled task check failed:', error);
      }
    }
  }, { timezone: 'Asia/Shanghai' });
  return [customTask];
}
