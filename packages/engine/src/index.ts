/** 引擎公共出口：外部只能用这些；内部文件不保证稳定 */
export { DefaultArbiter, DEFAULT_LIMITS } from "./arbiter.ts";
export type { ArbiterLimits, ArbiterOptions } from "./arbiter.ts";
export { EventSourcedStore, FileStore } from "./store.ts";
export type { EventLog, StoreOptions } from "./store.ts";
export { applyEvent, createInitialState } from "./projection.ts";
export { JsonRegistry, emptyRegistry } from "./registry.ts";
export type { RegistrySource } from "./registry.ts";
export { ModuleHost } from "./modules.ts";
export { DefaultTurn } from "./turn.ts";
export { InMemoryMemory } from "./memory.ts";
export { DialogueHost } from "./dialogue.ts";
export { MemoryTransport } from "./transport.ts";
export { buildView } from "./view.ts";
