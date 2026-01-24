/**
 * Example PLC Application
 *
 * Demonstrates how to use @tentacle/plc as a library.
 */

import {
  createLogger,
  createPlc,
  LogLevel,
  type PlcTask,
  type PlcVariableBooleanConfig,
  type PlcVariableNumberConfig,
  type PlcVariablesRuntime,
} from "../mod.ts";

// Create a logger for this application
const log = createLogger("example", LogLevel.info);

// =============================================================================
// Define Variables (configuration only, no runtime values)
// =============================================================================

const variables = {
  temperature: {
    id: "temperature",
    description: "Temperature sensor reading",
    datatype: "number",
    default: 20,
    source: { bidirectional: true },
  } satisfies PlcVariableNumberConfig,

  pressure: {
    id: "pressure",
    description: "Pressure sensor reading",
    datatype: "number",
    default: 100,
    source: {}, // Subject auto-derived as: my-plc-project/pressure
  } satisfies PlcVariableNumberConfig,

  isRunning: {
    id: "isRunning",
    description: "Whether the system is running",
    datatype: "boolean",
    default: false,
    source: { bidirectional: true },
  } satisfies PlcVariableBooleanConfig,

  // Command variable - meant to be written to from external sources (MQTT, GraphQL, etc.)
  motorStartCmd: {
    id: "motorStartCmd",
    description: "Motor start command - write true to start, false to stop",
    datatype: "boolean",
    default: false,
    source: { bidirectional: true },
  } satisfies PlcVariableBooleanConfig,

  // Status feedback - read-only, reflects actual motor state
  motorRunning: {
    id: "motorRunning",
    description: "Motor running status feedback",
    datatype: "boolean",
    default: false,
  } satisfies PlcVariableBooleanConfig,

  // Motor speed feedback
  motorSpeed: {
    id: "motorSpeed",
    description: "Motor speed in RPM",
    datatype: "number",
    default: 0,
  } satisfies PlcVariableNumberConfig,
};

// Type for runtime variables
type Variables = typeof variables;
type VariablesRuntime = PlcVariablesRuntime<Variables>;

// =============================================================================
// Define Tasks
// =============================================================================

const tasks: Record<string, PlcTask<Variables>> = {
  main: {
    name: "Monitor Temperature and Pressure",
    description: "Simulate realistic temperature and pressure readings",
    scanRate: 100,
    program: (vars: VariablesRuntime, updateVariable) => {
      // Simulate temperature with realistic variation (±2°C around 20°C)
      const baseTemp = 20;
      const tempVariation = 2 * Math.sin(Date.now() / 5000) +
        (Math.random() - 0.5) * 1;
      const newTemp = Math.round((baseTemp + tempVariation) * 10) / 10;
      updateVariable("temperature", newTemp);

      // Simulate pressure based on isRunning state
      const targetPressure = vars.isRunning.value ? 40 : 1;
      const currentPressure = vars.pressure.value;

      // Pressure changes gradually toward target with some oscillation
      const pressureDelta = (targetPressure - currentPressure) * 0.1;
      const oscillation = 2 * Math.sin(Date.now() / 3000);
      const noise = (Math.random() - 0.5) * 0.5;
      const newPressure = Math.round(
        (currentPressure + pressureDelta + oscillation + noise) * 100,
      ) / 100;

      updateVariable("pressure", newPressure);
    },
  },

  motorControl: {
    name: "Motor Control",
    description: "Respond to motor start command and simulate motor behavior",
    scanRate: 100,
    program: (vars: VariablesRuntime, updateVariable) => {
      const commanded = vars.motorStartCmd.value;
      const running = vars.motorRunning.value;
      const currentSpeed = vars.motorSpeed.value;

      // Target speed based on command
      const targetSpeed = commanded ? 1750 : 0; // 1750 RPM when running

      // Motor takes time to start/stop (simulate inertia)
      if (commanded && !running && currentSpeed > 100) {
        // Motor has spun up enough - mark as running
        updateVariable("motorRunning", true);
      } else if (!commanded && running && currentSpeed < 100) {
        // Motor has slowed down enough - mark as stopped
        updateVariable("motorRunning", false);
      }

      // Gradually change speed toward target (ramp up/down)
      const speedDiff = targetSpeed - currentSpeed;
      const rampRate = commanded ? 0.05 : 0.08; // Faster decel than accel
      const speedChange = speedDiff * rampRate;
      const noise = running ? (Math.random() - 0.5) * 10 : 0; // Speed variation when running
      const newSpeed = Math.max(
        0,
        Math.round(currentSpeed + speedChange + noise),
      );

      updateVariable("motorSpeed", newSpeed);
    },
  },

  logger: {
    name: "Logger",
    description: "Log variable values periodically",
    scanRate: 1000,
    program: (vars: VariablesRuntime) => {
      log.info(
        `Temp: ${vars.temperature.value}°C | ` +
          `Pressure: ${vars.pressure.value} psi | ` +
          `Motor: ${vars.motorRunning.value ? "RUNNING" : "STOPPED"} @ ${vars.motorSpeed.value} RPM | ` +
          `Cmd: ${vars.motorStartCmd.value}`,
      );
    },
  },
};

// =============================================================================
// Create and Run PLC
// =============================================================================

const plc = await createPlc({
  projectId: "my-plc-project",
  variables,
  tasks,
  nats: {
    servers: Deno.env.get("NATS_SERVERS") || "nats://localhost:4222",
  },
});

// Handle graceful shutdown
Deno.addSignalListener("SIGINT", async () => {
  log.info("Received SIGINT, stopping...");
  await plc.stop();
  Deno.exit(0);
});

log.info("Press Ctrl+C to stop.");
log.info("Example commands:");
log.info("  nats pub my-plc-project/temperature 25");
log.info("  nats pub my-plc-project/isRunning true");
log.info("  nats pub my-plc-project/motorStartCmd true   # Start motor");
log.info("  nats pub my-plc-project/motorStartCmd false  # Stop motor");
