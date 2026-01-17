import { PlcVariables, NatsConfig } from "./variables.ts";

export type PlcTasks<V extends PlcVariables> = {
  name: string;
  description: string;
  scanRate: number;
  program: (
    variables: PlcVariables<V>,
    updateVariable: (
      variableId: keyof PlcVariables<V>,
      value: number | boolean | string,
    ) => void,
  ) => Promise<void> | void;
};

export type PlcConfig<V extends PlcVariables> = {
  variables: V;
  tasks: PlcTasks<V>[];
  nats?: NatsConfig;
};
