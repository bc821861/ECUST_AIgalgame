/** ModuleContext 的组装：模块只能通过它看世界（读）与调模型（说），不能写。 */
import type {
  LlmPort,
  ModuleContext,
  Registry,
  TurnRequest,
  WorldState,
} from "../../shared/src/index.ts";

export function makeContext(registry: Registry, llm: LlmPort, req: TurnRequest, state: WorldState): ModuleContext {
  const e = (id: string) => state.entities[id];
  return {
    roomId: req.roomId,
    actorId: req.actorId,
    input: req.input,
    state,
    registry,
    clock: state.clock,
    query: {
      entity: (id) => e(id),
      attr: (entityId, key) => e(entityId)?.attrs[key],
      present: () => [...state.room.scene.presentIds],
      links: (kind, from) => state.links.filter((l) => (!kind || l.kind === kind) && (!from || l.from === from)),
    },
    llm,
    log: (msg) => (process.env.GALGAME_DEBUG ? console.error(`[module] ${msg}`) : undefined),
  };
}
