export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;

/** Structured logger. Fields must never carry prompt text, model output or keys. */
export interface Logger {
  debug(message: string, fields: LogFields): void;
  info(message: string, fields: LogFields): void;
  warn(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields): void;
}

const noop = () => undefined;
export const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
