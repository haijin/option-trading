import { Command, CommanderError } from 'commander';
import { UserError } from '../core/util';
import type { CliContext } from './context';

export type Registrar = (program: Command, ctx: CliContext) => void;

/** Command groups are added to this list as they are implemented (see src/cli/commands/*). */
const registrars: Registrar[] = [];

export function registerCommands(...r: Registrar[]): void {
  registrars.push(...r);
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program
    .name('option-trading')
    .description('Sell-put decision-support scanner for a personal HK + US watchlist. Never places orders.')
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.out(s.replace(/\n$/, '')),
      writeErr: (s) => ctx.err(s.replace(/\n$/, '')),
    });
  for (const r of registrars) r(program, ctx);
  return program;
}

/** Runs one CLI invocation and returns the process exit code (0 ok, 1 user error, 2 unexpected failure). */
export async function runCli(argv: string[], ctx: CliContext & { closeDb?: () => Promise<void> }): Promise<number> {
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version exit with code 0 and a CommanderError carrying it.
      return err.exitCode;
    }
    if (err instanceof UserError) {
      ctx.err(err.message);
      return err.exitCode;
    }
    ctx.err(`unexpected error: ${(err as Error).stack ?? String(err)}`);
    return 2;
  } finally {
    await ctx.closeDb?.();
  }
}
