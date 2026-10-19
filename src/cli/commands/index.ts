import { registerCommands } from '../program';
import { registerBacktest } from './backtest';
import { registerData } from './data';
import { registerFutu } from './futu';
import { registerLeaders } from './leaders';
import { registerOps } from './ops';
import { registerReminders } from './reminders';
import { registerScan } from './scan';
import { registerSetup } from './setup';

/** Registers every command group. Each group lives in its own file next to this one. */
registerCommands(
  registerSetup,
  registerData,
  registerOps,
  registerBacktest,
  registerScan,
  registerFutu,
  registerLeaders,
  registerReminders,
);
