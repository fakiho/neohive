'use strict';

const LOG_LEVEL = (process.env.NEOHIVE_LOG_LEVEL || 'warn').toLowerCase();
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const log = {
  error: (...args) => { if (LOG_LEVELS[LOG_LEVEL] >= 0) process.stderr.write('[NEOHIVE:ERROR] ' + args.map(String).join(' ') + '\n'); },
  warn:  (...args) => { if (LOG_LEVELS[LOG_LEVEL] >= 1) process.stderr.write('[NEOHIVE:WARN] ' + args.map(String).join(' ') + '\n'); },
  info:  (...args) => { if (LOG_LEVELS[LOG_LEVEL] >= 2) process.stderr.write('[NEOHIVE:INFO] ' + args.map(String).join(' ') + '\n'); },
  debug: (...args) => { if (LOG_LEVELS[LOG_LEVEL] >= 3) process.stderr.write('[NEOHIVE:DEBUG] ' + args.map(String).join(' ') + '\n'); },
};

module.exports = log;
