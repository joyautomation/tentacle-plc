import { assertEquals } from "jsr:@std/assert";
import { connect } from "@nats-io/transport-deno";
import { parseValue, setupNats } from "./nats.ts";
import type {
  PlcVariableBoolean,
  PlcVariableNumber,
  PlcVariables,
} from "./types/variables.ts";

// Test variables
type TestVariables = PlcVariables<{
  temperature: PlcVariableNumber;
  pumpActive: PlcVariableBoolean;
}>;

const testVariables: TestVariables = {
  temperature: {
    id: "temperature",
    description: "Temperature reading",
    datatype: "number",
    default: 0,
    value: 0,
    source: {
      subject: "test-project/temperature",
    },
  },
  pumpActive: {
    id: "pumpActive",
    description: "Pump status",
    datatype: "boolean",
    default: false,
    value: false,
    source: {
      subject: "test-project/pumpActive",
    },
  },
};

const natsConfig = {
  servers: "localhost:4222",
};

const projectId = "test-project";

// Helper functions
async function startNatsDocker(): Promise<void> {
  try {
    const command = new Deno.Command("docker", {
      args: [
        "run",
        "-d",
        "--name",
        "nats-test",
        "-p",
        "4222:4222",
        "nats:latest",
        "-js",
      ],
    });
    await command.output();
    // Wait for NATS to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error("Failed to start NATS Docker container:", error);
    throw error;
  }
}

async function stopNatsDocker(): Promise<void> {
  try {
    const stopCmd = new Deno.Command("docker", {
      args: ["stop", "nats-test"],
    });
    await stopCmd.output();

    const rmCmd = new Deno.Command("docker", {
      args: ["rm", "nats-test"],
    });
    await rmCmd.output();
  } catch (error) {
    console.error("Failed to stop NATS Docker container:", error);
  }
}

// Tests
Deno.test({
  name: "setupNats - establishes connection and subscribes to subjects",
  async fn() {
    await startNatsDocker();
    try {
      const updates: Array<{
        variableId: string;
        value: number | boolean | string | Record<string, unknown>;
      }> = [];

      const manager = await setupNats(
        natsConfig,
        testVariables,
        projectId,
        (id, value) => {
          updates.push({ variableId: id as string, value });
        },
      );

      try {
        // Give subscriptions time to be established
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Connect as publisher and send messages
        const nc = await connect(natsConfig);
        try {
          nc.publish("test-project/temperature", "25.5");
          nc.publish("test-project/pumpActive", "true");

          // Wait for messages to be processed
          await new Promise((resolve) => setTimeout(resolve, 500));

          assertEquals(updates.length, 2);
          assertEquals(updates[0].variableId, "temperature");
          assertEquals(updates[0].value, 25.5);
          assertEquals(updates[1].variableId, "pumpActive");
          assertEquals(updates[1].value, true);
        } finally {
          await nc.close();
        }
      } finally {
        await manager.disconnect();
      }
    } finally {
      await stopNatsDocker();
    }
  },
});

Deno.test({
  name: "setupNats - publish method sends schema-compliant messages",
  async fn() {
    await startNatsDocker();
    try {
      const manager = await setupNats(natsConfig, testVariables, projectId, () => {});

      try {
        // Wait for manager to be fully initialized
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Connect as subscriber to verify messages on schema topic
        const nc = await connect(natsConfig);
        try {
          const receivedMessages: string[] = [];

          const sub = nc.subscribe(`plc.data.${projectId}.temperature`);
          // Wait for subscription to be ready
          await new Promise((resolve) => setTimeout(resolve, 200));

          (async () => {
            for await (const msg of sub) {
              receivedMessages.push(msg.string());
              if (receivedMessages.length >= 1) break;
            }
          })();

          // Publish via manager with datatype
          await manager.publish("temperature", 42.3, "number");

          // Wait for message to be received
          await new Promise((resolve) => setTimeout(resolve, 500));

          assertEquals(receivedMessages.length, 1);
          const parsed = JSON.parse(receivedMessages[0]);
          assertEquals(parsed.value, 42.3);
          assertEquals(parsed.datatype, "number");
          assertEquals(parsed.projectId, projectId);

          await sub.unsubscribe();
        } finally {
          await nc.close();
        }
      } finally {
        await manager.disconnect();
      }
    } finally {
      await stopNatsDocker();
    }
  },
});

Deno.test({
  name: "setupNats - disconnect cleanly stops subscriptions",
  async fn() {
    await startNatsDocker();
    try {
      let updateCount = 0;
      const manager = await setupNats(natsConfig, testVariables, projectId, () => {
        updateCount++;
      });

      const nc = await connect(natsConfig);
      try {
        // Publish some messages
        nc.publish("test-project/temperature", "20");
        await new Promise((resolve) => setTimeout(resolve, 100));

        const countBeforeDisconnect = updateCount;

        // Disconnect manager
        await manager.disconnect();

        // Publish more messages after disconnect
        nc.publish("test-project/temperature", "30");
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Should not have received the message after disconnect
        assertEquals(updateCount, countBeforeDisconnect);
      } finally {
        await nc.close();
      }
    } finally {
      await stopNatsDocker();
    }
  },
});

Deno.test({
  name: "parseValue - handles number parsing",
  fn() {
    assertEquals(parseValue("42", "number"), 42);
    assertEquals(parseValue("3.14", "number"), 3.14);
    assertEquals(parseValue("0", "number"), 0);
  },
});

Deno.test({
  name: "parseValue - handles boolean parsing",
  fn() {
    assertEquals(parseValue("true", "boolean"), true);
    assertEquals(parseValue("false", "boolean"), false);
    assertEquals(parseValue("1", "boolean"), true);
    assertEquals(parseValue("0", "boolean"), false);
    assertEquals(parseValue("on", "boolean"), true);
    assertEquals(parseValue("off", "boolean"), false);
    assertEquals(parseValue("yes", "boolean"), true);
    assertEquals(parseValue("no", "boolean"), false);
    assertEquals(parseValue("  true  ", "boolean"), true);
    assertEquals(parseValue("TRUE", "boolean"), true);
  },
});

Deno.test({
  name: "parseValue - handles string parsing",
  fn() {
    assertEquals(parseValue("hello", "string"), "hello");
    assertEquals(parseValue("123", "string"), "123");
    assertEquals(parseValue("", "string"), "");
  },
});

Deno.test({
  name: "parseValue - handles UDT JSON parsing",
  fn() {
    const jsonString = '{"x": 10, "y": 20}';
    const result = parseValue(jsonString, "udt");
    assertEquals(result, { x: 10, y: 20 });

    // Invalid JSON returns as string
    const invalidJson = "{invalid}";
    assertEquals(parseValue(invalidJson, "udt"), invalidJson);
  },
});
