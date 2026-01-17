/**
 * Example: Report By Exception (RBE) Configuration
 *
 * This example demonstrates how to configure Report By Exception (deadband) settings
 * for PLC variables. These settings flow through NATS to tentacle-mqtt and are
 * honored by the Synapse MQTT publisher.
 *
 * RBE Settings:
 * - deadband.value: Only publish if change exceeds this threshold (for numeric types)
 * - deadband.maxTime: Force publish if this time elapses, regardless of change
 * - disableRBE: Debug flag to force publish all changes (overrides deadband)
 *
 * Flow:
 * 1. Define variables with deadband in tentacle-plc
 * 2. tentacle-plc publishes to NATS: plc.data.{projectId}.{variableId}
 * 3. NATS KV stores deadband metadata: plc-variables-{projectId}
 * 4. tentacle-mqtt discovers variables from NATS
 * 5. tentacle-mqtt applies deadband when creating Synapse metrics
 * 6. Synapse honors RBE and only publishes when thresholds are met
 */

import type { PlcVariables } from "../types/variables.ts";

/**
 * Example variables with different RBE configurations
 */
export const rbeExampleVariables: PlcVariables = {
  // Temperature sensor - only publish if change > 0.5°C or every 60 seconds
  temperature: {
    id: "temperature",
    description: "Building temperature sensor",
    datatype: "number",
    default: 20,
    value: 20,
    deadband: {
      value: 0.5, // Publish only if change > 0.5 degrees
      maxTime: 60000, // But publish at least every 60 seconds
    },
    source: {
      subject: "sensors/temperature",
      bidirectional: false,
    },
  },

  // Pressure sensor - tighter deadband for critical system
  pressure: {
    id: "pressure",
    description: "System pressure (critical)",
    datatype: "number",
    default: 101.3,
    value: 101.3,
    deadband: {
      value: 0.1, // Only publish if change > 0.1 kPa (tight tolerance)
      maxTime: 30000, // Force publish every 30 seconds for safety
    },
    source: {
      bidirectional: false,
    },
  },

  // Humidity - less critical, larger deadband
  humidity: {
    id: "humidity",
    description: "Ambient humidity",
    datatype: "number",
    default: 50,
    value: 50,
    deadband: {
      value: 5, // Only publish if change > 5% (loose deadband)
      maxTime: 300000, // But publish at least every 5 minutes
    },
  },

  // Status flag - boolean, usually no deadband needed
  systemHealthy: {
    id: "systemHealthy",
    description: "System health status",
    datatype: "boolean",
    default: true,
    value: true,
    // No deadband for boolean - publish on every change
    source: {
      bidirectional: false,
    },
  },

  // Run counter - only publish every 100 increments
  cycleCount: {
    id: "cycleCount",
    description: "Total machine cycles (increments frequently)",
    datatype: "number",
    default: 0,
    value: 0,
    deadband: {
      value: 100, // Only publish if count increases by 100+
      maxTime: 600000, // Or at least every 10 minutes
    },
  },

  // Debug variable - RBE disabled for testing
  debugValue: {
    id: "debugValue",
    description: "Debug value (RBE disabled for troubleshooting)",
    datatype: "number",
    default: 0,
    value: 0,
    disableRBE: true, // Force publish every change during debugging
    // Note: Once testing is done, remove disableRBE to enable normal RBE
  },
};

/**
 * Example of how RBE settings flow through the system
 *
 * In tentacle-plc:
 * ```
 * const variables = rbeExampleVariables;
 * // When temperature changes from 20.0 to 20.3, it won't publish (< 0.5 threshold)
 * // When temperature changes from 20.0 to 20.6, it publishes (> 0.5 threshold)
 * // Even if no change, publishes every 60 seconds (maxTime)
 * ```
 *
 * In NATS:
 * - Topic: plc.data.my-project.temperature
 * - Includes: value, datatype, deadband metadata
 *
 * - KV: plc-variables-my-project:temperature
 * - Stores: full variable state including deadband config
 *
 * In tentacle-mqtt:
 * - Discovers variables from both NATS topics and KV bucket
 * - Reads deadband configuration from NATS messages
 * - When creating Synapse metrics: applies deadband settings
 *
 * In Synapse (MQTT publisher):
 * - Respects deadband when publishing DDATA messages
 * - Uses lastPublished timestamps to enforce maxTime
 * - Only publishes metrics that pass RBE checks
 * - Results in fewer MQTT messages while maintaining data accuracy
 */

/**
 * Configuration recommendations by use case:
 *
 * 1. High-frequency sensors (sampled 100x/sec):
 *    - Use deadband to reduce network traffic
 *    - Example: temperature with deadband.value = 0.5, maxTime = 60000
 *
 * 2. Critical variables (safety-related):
 *    - Use tight deadband and short maxTime
 *    - Example: pressure with deadband.value = 0.1, maxTime = 10000
 *    - Ensures timely updates even for small changes
 *
 * 3. Counters (monotonically increasing):
 *    - Use deadband equal to meaningful increment
 *    - Example: cycleCount with deadband.value = 100
 *    - Reduces noise from constant counting
 *
 * 4. Boolean states (no intermediate values):
 *    - Omit deadband entirely
 *    - Will publish on every state change
 *
 * 5. Debug/testing:
 *    - Set disableRBE = true temporarily
 *    - See every change without RBE filtering
 *    - Remember to remove before production
 *
 * 6. Low-importance values:
 *    - Use large deadband and long maxTime
 *    - Example: status with deadband.value = 10, maxTime = 300000
 *    - Minimizes message volume
 */

/**
 * Real-world scenario: HVAC system monitoring
 */
export const hvacVariables: PlcVariables = {
  // Building temperature - significant changes only
  buildingTemp: {
    id: "buildingTemp",
    description: "Main building temperature",
    datatype: "number",
    default: 22,
    value: 22,
    deadband: {
      value: 0.5, // Alert if drifts more than 0.5°C
      maxTime: 120000, // But report at least every 2 minutes
    },
  },

  // Compressor run hours - large increments
  compressorHours: {
    id: "compressorHours",
    description: "Total compressor runtime in hours",
    datatype: "number",
    default: 1000,
    value: 1000,
    deadband: {
      value: 1, // Report every 1 hour of runtime
      maxTime: 3600000, // At least hourly
    },
  },

  // Filter pressure drop - safety critical
  filterPressure: {
    id: "filterPressure",
    description: "Filter pressure differential (replacement needed at 500Pa)",
    datatype: "number",
    default: 150,
    value: 150,
    deadband: {
      value: 10, // Alert if pressure rises by 10 Pa
      maxTime: 60000, // Check very frequently for safety
    },
  },

  // System on/off - publish every change
  systemRunning: {
    id: "systemRunning",
    description: "Is HVAC system currently running?",
    datatype: "boolean",
    default: true,
    value: true,
    // No deadband - state changes are important
  },
};

export default rbeExampleVariables;
