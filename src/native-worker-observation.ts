import type { EffectivePiRoute } from "./model-reasoning-routing.ts";
import type { TaskIdentity } from "./task-recovery.ts";

export type NativeWorkerObservation = {
  effectiveRoute?: EffectivePiRoute;
  identity: TaskIdentity;
  stateDirectory: string;
  phase: "DISCOVER" | "DEBUG" | "BUILD" | "VERIFY";
};

export type NativeWorkerObserver = (observation: NativeWorkerObservation) => Promise<void> | void;
export type NativeWorkerResultObserver = (identity: TaskIdentity) => Promise<void> | void;
export type NativeWorkerCleanupObserver = (identity: TaskIdentity) => Promise<void> | void;
