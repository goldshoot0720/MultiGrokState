#!/usr/bin/env node
import chalk from 'chalk';

import { runCli } from '../src/cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(chalk.red(`\n  ✖ ${err.message}\n`));
  process.exitCode = 1;
});
