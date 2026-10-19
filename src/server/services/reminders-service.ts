import { buildRemindersView } from '../../db/reminders';
import type { RemindersJobPorts } from '../../jobs/jobs';
import type { ISODate, RemindersView } from '../api-types';
import type { ServerDeps } from '../deps';

export class RemindersService {
  constructor(private readonly deps: ServerDeps) {}

  jobPorts(): RemindersJobPorts {
    return {
      digest: async (today: ISODate) => {
        try {
          const view = await this.view(today, 30);
          const todayCount = view.today.length;
          const upcomingCount = view.upcoming.length;
          const detail = `${todayCount} due today, ${upcomingCount} upcoming (next 30 days)`;
          return { items: todayCount + upcomingCount, detail, failed: false };
        } catch (err) {
          return { items: 0, detail: (err as Error).message, failed: true };
        }
      },
    };
  }

  view(today: ISODate, days = 30): Promise<RemindersView> {
    return buildRemindersView(this.deps.db, today, days);
  }
}
