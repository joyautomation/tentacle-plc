/**
 * Standalone ladder DSL test — no NATS required.
 *
 * Run: deno run tentacle-plc/ladder_test.ts
 */

import {
  createLadderProgram,
  NO,
  NC,
  OTE,
  OTL,
  OTU,
  TON,
  branch,
} from "./ladder.ts";

// Simulated PLC variables (in-memory)
const vars: Record<string, { value: unknown }> = {
  startButton: { value: false },
  stopButton: { value: false },
  motorRunning: { value: false },
  highTemp: { value: false },
  alarmAck: { value: false },
  tempAlarm: { value: false },
  timerDone: { value: false },
};

function updateVariable(id: string, value: unknown) {
  if (!vars[id]) vars[id] = { value };
  else vars[id].value = value;
}

function printState(label: string) {
  console.log(`\n--- ${label} ---`);
  for (const [k, v] of Object.entries(vars)) {
    console.log(`  ${k}: ${v.value}`);
  }
}

// Define ladder program (motor start/stop with seal-in + alarm latch)
const program = createLadderProgram(({ rung }) => {
  // Rung 0: Motor start/stop with seal-in
  rung(
    branch(
      NO("startButton"),
      NO("motorRunning"),
    ),
    NC("stopButton"),
    OTE("motorRunning"),
  );

  // Rung 1: Run timer (just the timer, no OTE on same rung)
  rung(
    NO("motorRunning"),
    TON("runTimer", 500), // 500ms for quick test
  );

  // Rung 2: Timer done — use the internal .DN tag
  rung(
    NO("runTimer.DN"),
    OTE("timerDone"),
  );

  // Rung 3: Alarm latch
  rung(
    NO("highTemp"),
    NC("alarmAck"),
    OTL("tempAlarm"),
  );

  // Rung 4: Alarm reset
  rung(
    NO("alarmAck"),
    OTU("tempAlarm"),
  );
});

// ---- Test Sequence ----

console.log("=== Ladder DSL Test ===");

// Initial scan — everything off
program(vars, updateVariable);
printState("Scan 1: Initial (all off)");

// Press start button
vars.startButton.value = true;
program(vars, updateVariable);
printState("Scan 2: Start button pressed (timerDone should be false)");

// Release start button — motor should seal in
vars.startButton.value = false;
program(vars, updateVariable);
printState("Scan 3: Start released (motor sealed in, timer running)");

// Wait for timer to expire
console.log("\n... waiting 600ms for TON timer ...");
await new Promise((r) => setTimeout(r, 600));

program(vars, updateVariable);
printState("Scan 4: After timer (timerDone should be true via runTimer.DN)");

// Press stop button — motor should stop
vars.stopButton.value = true;
program(vars, updateVariable);
printState("Scan 5: Stop pressed (motor off, timer resets)");

vars.stopButton.value = false;
program(vars, updateVariable);
printState("Scan 6: Stop released");

// Test alarm latch
vars.highTemp.value = true;
program(vars, updateVariable);
printState("Scan 7: High temp (alarm latches)");

vars.highTemp.value = false;
program(vars, updateVariable);
printState("Scan 8: Temp normal (alarm stays latched)");

// Acknowledge alarm — OTU should unlatch
vars.alarmAck.value = true;
program(vars, updateVariable);
printState("Scan 9: Alarm ack (alarm unlatched)");

vars.alarmAck.value = false;
program(vars, updateVariable);
printState("Scan 10: Final state");

console.log("\n=== All tests complete ===");
