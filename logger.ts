/**
 * Shared Logger Module
 *
 * Provides coral loggers for the PLC runtime and NATS modules.
 * After NATS connects, enableNatsLogging() upgrades all registered
 * loggers to also publish to NATS for real-time streaming.
 *
 * Downstream apps should use createPlcLogger() instead of coral's
 * createLogger() — this registers the logger so it automatically
 * gets NATS publishing when createPlc() is called.
 */

import { createLogger, LogLevel, type Log } from "@joyautomation/coral";
import type { NatsConnection } from "@nats-io/transport-deno";

export { LogLevel, type Log };

let currentLevel = LogLevel.info;

export const log: Record<string, Log> = {};

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

/**
 * Create a logger that automatically gets NATS publishing when createPlc() runs.
 *
 * Use this instead of coral's createLogger() so your application logs
 * show up in the tentacle web UI's Logs tab.
 *
 * @example
 * ```typescript
 * import { createPlcLogger, createPlc } from "@tentacle/plc";
 *
 * const log = createPlcLogger("my-app");
 * log.info("Starting up..."); // console only (NATS not connected yet)
 *
 * const plc = await createPlc({ ... });
 * log.info("Running!"); // console + NATS (auto-upgraded)
 * ```
 */
export function createPlcLogger(name: string, level?: LogLevel): Log {
  const coralLogger = createLogger(name, level ?? currentLevel);
  log[name] = coralLogger;

  // Return getter-based proxy that always resolves to the current
  // (possibly wrapped) logger from the shared map
  return {
    get info() { return log[name].info.bind(log[name]); },
    get warn() { return log[name].warn.bind(log[name]); },
    get error() { return log[name].error.bind(log[name]); },
    get debug() { return log[name].debug.bind(log[name]); },
  } as Log;
}

/** Shape of a service log entry published to NATS */
interface ServiceLogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  serviceType: string;
  moduleId: string;
  logger?: string;
}

/**
 * Wrap a coral logger to also publish log entries to NATS.
 */
function wrapLogger(
  coralLog: Log,
  publishFn: (level: string, loggerName: string, msg: string) => void,
  loggerName: string,
): Log {
  const formatArgs = (args: unknown[]): string =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  return {
    info: (msg: string, ...args: unknown[]) => {
      coralLog.info(msg, ...args);
      publishFn("info", loggerName, args.length > 0 ? `${msg} ${formatArgs(args)}` : msg);
    },
    warn: (msg: string, ...args: unknown[]) => {
      coralLog.warn(msg, ...args);
      publishFn("warn", loggerName, args.length > 0 ? `${msg} ${formatArgs(args)}` : msg);
    },
    error: (msg: string, ...args: unknown[]) => {
      coralLog.error(msg, ...args);
      publishFn("error", loggerName, args.length > 0 ? `${msg} ${formatArgs(args)}` : msg);
    },
    debug: (msg: string, ...args: unknown[]) => {
      coralLog.debug(msg, ...args);
      publishFn("debug", loggerName, args.length > 0 ? `${msg} ${formatArgs(args)}` : msg);
    },
  } as Log;
}

/**
 * Upgrade all exported loggers to also publish to NATS.
 * Call once after NATS connects. Since `log` is a shared object,
 * all modules that imported it will see the wrapped loggers.
 */
export function enableNatsLogging(
  nc: NatsConnection,
  serviceType: string,
  moduleId: string,
): void {
  const subject = `service.logs.${serviceType}.${moduleId}`;
  const encoder = new TextEncoder();

  const publishFn = (level: string, loggerName: string, message: string) => {
    try {
      const entry: ServiceLogEntry = {
        timestamp: Date.now(),
        level: level as ServiceLogEntry["level"],
        message,
        serviceType,
        moduleId,
        logger: loggerName,
      };
      nc.publish(subject, encoder.encode(JSON.stringify(entry)));
    } catch {
      // Never let log publishing break the service
    }
  };

  // Wrap each logger in-place
  for (const key of Object.keys(log)) {
    log[key] = wrapLogger(log[key], publishFn, `plc:${key}`);
  }
}
