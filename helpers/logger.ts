import pino from 'pino';

const transport = pino.transport({
  target: 'pino-pretty',
  options: {
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
    colorize: true,
  },
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    redact: ['poolKeys.authority'],
  },
  transport,
);
