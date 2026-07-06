// src/logger/index.ts
// Структуровані JSON-логи через pino

import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logging.level,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    pid: process.pid,
  },
});

export type Logger = typeof logger;
