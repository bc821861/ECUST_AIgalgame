/**
 * Dialogue：NPC 自主对话的唯一入口。引擎只负责开会话、记轮次、汇总；
 * "怎么说话"全在导演（content/directors/*.ts）。新增对话形态 = 新增一个导演文件。
 */
import type {
  ActorId,
  Dialogue,
  DialogueDirector,
  DialogueSession,
  DialogueSpec,
  DialogueStep,
  DialogueSummary,
  Id,
  ModuleContext,
  Proposal,
} from "../../shared/src/index.ts";

export type ContextFactory = (spec: DialogueSpec) => ModuleContext | Promise<ModuleContext>;

export class DialogueHost implements Dialogue {
  private readonly sessions = new Map<Id, DialogueSession>();
  private readonly directors = new Map<string, DialogueDirector>();
  private readonly makeContext: ContextFactory;
  private nextId = 0;

  constructor(makeContext: ContextFactory, directors: DialogueDirector[] = []) {
    this.makeContext = makeContext;
    for (const d of directors) this.directors.set(d.id, d);
  }

  register(d: DialogueDirector): void {
    this.directors.set(d.id, d);
  }

  async open(spec: DialogueSpec): Promise<DialogueSession> {
    if (!this.directors.has(spec.directorId)) throw new Error(`E_DIALOGUE_DIRECTOR: ${spec.directorId}`);
    const session: DialogueSession = {
      id: `dlg_${++this.nextId}`,
      roomId: spec.roomId,
      participants: [...spec.participants],
      directorId: spec.directorId,
      turn: 0,
      maxTurns: spec.maxTurns ?? 6,
      status: "open",
      visibility: spec.visibility ?? "private",
      seed: { ...(spec.seed ?? {}) },
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async step(sessionId: Id): Promise<DialogueStep> {
    return this.advance(sessionId);
  }

  async interject(sessionId: Id, actorId: ActorId, text: string): Promise<DialogueStep> {
    const s = this.need(sessionId);
    if (!s.participants.includes(actorId)) throw new Error("E_NOT_IN_DIALOGUE");
    // 玩家插话算一轮，但不额外调 LLM：把话塞进 seed 交给导演自己处理
    const said = (s.seed.injected as { actorId: ActorId; text: string }[] | undefined) ?? [];
    s.seed.injected = [...said.slice(-3), { actorId, text }];
    return this.advance(sessionId);
  }

  async close(sessionId: Id, outcome?: string): Promise<DialogueSummary> {
    const s = this.need(sessionId);
    s.status = "closed";
    return { sessionId, turn: s.turn, outcome, proposals: (s.seed.pending as Proposal[] | undefined) ?? [] };
  }

  private async advance(sessionId: Id): Promise<DialogueStep> {
    const s = this.need(sessionId);
    if (s.status === "closed") throw new Error("E_DIALOGUE_CLOSED");
    const director = this.directors.get(s.directorId);
    if (!director) throw new Error(`E_DIALOGUE_DIRECTOR: ${s.directorId}`);
    const ctx = await this.makeContext({
      roomId: s.roomId,
      participants: s.participants,
      directorId: s.directorId,
      seed: s.seed,
      maxTurns: s.maxTurns,
      visibility: s.visibility,
    });
    // 一轮最多一次 LLM 调用（导演内部自己保证），这里只限轮次
    s.turn += 1;
    const step = await director.nextTurn(s, ctx);
    const done = step.done || s.turn >= s.maxTurns;
    if (done) s.status = "closed";
    const pending = (s.seed.pending as Proposal[] | undefined) ?? [];
    s.seed.pending = [...pending, ...step.proposals];
    return { ...step, sessionId, turn: s.turn, done };
  }

  private need(sessionId: Id): DialogueSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("E_DIALOGUE_NOT_FOUND");
    return s;
  }
}
