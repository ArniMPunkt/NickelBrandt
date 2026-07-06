#!/usr/bin/env node

const { runPrecheckCli } = require('./lib/precheck/run-precheck');

runPrecheckCli(process.argv.slice(2)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
