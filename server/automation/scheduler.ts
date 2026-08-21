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

export function startScheduler(engine: AutomationEngine): ScheduledTask[] {
  const expressions = ['0 9 * * *', '0 11 * * *', '30 17 * * *'];
  const fixedTasks = expressions.map((expression) => cron.schedule(expression, async () => {
    try {
      const settings = await engine.settings();
      if (settings.enabled && await engine.store.exists()) await engine.run('scheduled');
    } catch (error) {
      console.error('Scheduled tracking run failed:', error);
    }
  }, { timezone: 'Asia/Shanghai' }));
  const executedTaskKeys = new Set<string>();
  const customTask = cron.schedule('* * * * *', async () => {
    try {
      const settings = await engine.settings();
      if (!settings.enabled || !(await engine.store.exists())) return;
      const current = shanghaiMinute(new Date());
      for (const key of executedTaskKeys) if (!key.startsWith(current.date)) executedTaskKeys.delete(key);
      const tasks = await engine.listTasks();
      for (const task of tasks) {
        const taskKey = `${current.date}:${task.id}`;
        const lastRun = task.lastRunAt ? shanghaiMinute(new Date(task.lastRunAt)) : null;
        const alreadyRanToday = lastRun?.date === current.date && lastRun.time === task.scheduleTime;
        if (task.enabled && task.scheduleTime === current.time && !alreadyRanToday && !executedTaskKeys.has(taskKey)) {
          executedTaskKeys.add(taskKey);
          try {
            await engine.runTask(task.id);
          } catch (error) {
            executedTaskKeys.delete(taskKey);
            console.error(`Custom scheduled task ${task.id} failed:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Custom scheduled task check failed:', error);
    }
  }, { timezone: 'Asia/Shanghai' });
  return [...fixedTasks, customTask];
}
