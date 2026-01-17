import { type PlcConfig } from "./types/plc.ts";
import {
  type PlcVariableBoolean,
  type PlcVariableNumber,
} from "./types/variables.ts";
import { setupNats } from "./nats.ts";

// Define your PLC variables with NATS integration
type MyPlcVariables = {
  temperature: PlcVariableNumber;
  pressure: PlcVariableNumber;
  isRunning: PlcVariableBoolean;
};

const myVariables: MyPlcVariables = {
  temperature: {
    id: "temperature",
    description: "Temperature sensor reading",
    datatype: "number",
    default: 20,
    value: 20,
    source: {
      bidirectional: true,
    },
  },
  pressure: {
    id: "pressure",
    description: "Pressure sensor reading",
    datatype: "number",
    default: 100,
    value: 100,
    source: {
      // Subject will be auto-derived as: my-plc-project/pressure
    },
  },
  isRunning: {
    id: "isRunning",
    description: "Whether the system is running",
    datatype: "boolean",
    default: false,
    value: false,
    source: {
      bidirectional: true,
    },
  },
};

const config: PlcConfig<MyPlcVariables> = {
  variables: myVariables,
  tasks: [
    {
      name: "Monitor Temperature and Pressure",
      description: "Simulate realistic temperature and pressure readings",
      scanRate: 1000,
      program: async (variables, updateVariable) => {
        //Simulate temperature with realistic variation (±2°C around 20°C)
        const baseTemp = 20;
        const tempVariation = 2 * Math.sin(Date.now() / 5000) +
          (Math.random() - 0.5) * 1;
        const newTemp = Math.round((baseTemp + tempVariation) * 10) / 10;
        updateVariable("temperature", newTemp);

        // Simulate pressure based on isRunning state
        const targetPressure = variables.isRunning.value ? 40 : 1;
        const currentPressure = variables.pressure.value;

        // Pressure changes gradually toward target with some oscillation
        const pressureDelta = (targetPressure - currentPressure) * 0.1; // Gradual change (10% per scan)
        const oscillation = 2 * Math.sin(Date.now() / 3000); // Natural oscillation
        const noise = (Math.random() - 0.5) * 0.5; // Small random noise
        const newPressure = Math.round(
          (currentPressure + pressureDelta + oscillation + noise) * 100,
        ) / 100;

        updateVariable("pressure", newPressure);

        const temp = variables.temperature.value;
        const pressure = variables.pressure.value;
        const isRunning = variables.isRunning.value;
        console.log(
          `Temperature: ${temp}°C | Pressure: ${pressure} psi | Running: ${isRunning}`,
        );
      },
    },
  ],
  nats: {
    servers: "nats://localhost:4222",
    // Add auth if needed:
    // user: "username",
    // pass: "password",
  },
};

async function main() {
  console.log("Starting PLC with NATS integration...");

  // Setup NATS integration with schema compliance
  const projectId = "my-plc-project";
  const natsManager = await setupNats(
    config.nats!,
    config.variables,
    projectId,
    (variableId, value) => {
      console.log(
        `Variable ${String(variableId)} updated from NATS to: ${value}`,
      );
      // Update the variable in your PLC state here
      const variable = config.variables[variableId];
      if (variable) {
        (variable as any).value = value;
      }
    },
  );

  // Simulate PLC task execution
  console.log(`\nStarting PLC tasks for project: ${projectId}...`);
  console.log(`Schema topics published to: plc.data.${projectId}.<variableId>`);
  const task = config.tasks[0];
  const taskInterval = setInterval(async () => {
    await task.program(config.variables, (variableId, value) => {
      const variable = config.variables[variableId];
      if (variable) {
        (variable as any).value = value;
        // Publish changes to NATS with schema compliance
        natsManager.publish(variableId, value, variable.datatype).catch(
          (err) => {
            console.error(`Failed to publish ${String(variableId)}:`, err);
          },
        );
      }
    });
  }, task.scanRate);

  // Keep the program running
  console.log("PLC running. Press Ctrl+C to stop.\n");
  console.log("📤 Schema-compliant topics (auto-published):");
  console.log(`  plc.data.${projectId}.temperature`);
  console.log(`  plc.data.${projectId}.pressure`);
  console.log(`  plc.data.${projectId}.isRunning`);
  console.log("\n📥 Inbound command subjects (auto-derived):");
  console.log(`  ${projectId}/temperature`);
  console.log(`  ${projectId}/pressure`);
  console.log(`  ${projectId}/isRunning`);
  console.log("\nExample: nats pub my-plc-project/temperature 25\n");

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    clearInterval(taskInterval);
    await natsManager.disconnect();
    console.log("Disconnected from NATS");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error("Fatal error:", err);
    Deno.exit(1);
  });
}
