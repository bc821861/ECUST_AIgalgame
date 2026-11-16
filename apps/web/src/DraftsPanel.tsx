import { useCallback, useEffect, useState } from "react";
import {
  createDraft,
  getDraft,
  getMap,
  listDrafts,
  publishDraft,
  retryGenerate,
  reviewDraft,
} from "./api.ts";
import type { MapScene, SceneDraft } from "./api.ts";
import DraftCard from "./DraftCard.tsx";
import { errorMessage, sceneName } from "./ui.ts";
import type { LineKind } from "./ui.ts";

const TOKEN_KEY = "galgame.adminToken";

interface Props {
  roomId: string;
  push: (kind: LineKind, text: string) => void;
  onRefreshState: () => void;
}

interface Form {
  name: string;
  idea: string;
  anchorLocId: string;
}

/** 审核面板：玩家创建草案 + 管理员列表/审核/发布（docs/06 §5、§7） */
export default function DraftsPanel({ roomId, push, onRefreshState }: Props) {
  const [anchors, setAnchors] = useState<MapScene[]>([]);
  const [token, setToken] = useState("");
  const [drafts, setDrafts] = useState<SceneDraft[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState<Form>({ name: "", idea: "", anchorLocId: "" });
  const [created, setCreated] = useState<SceneDraft | null>(null);
  const [queryId, setQueryId] = useState("");
  const [queried, setQueried] = useState<SceneDraft | null>(null);

  const loadDrafts = useCallback(async (adminToken: string) => {
    if (!adminToken) return;
    setBusy("list");
    try {
      setDrafts(await listDrafts(adminToken));
      setErr("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const map = await getMap(roomId);
        setAnchors(map.scenes);
        setForm((prev) => ({
          ...prev,
          anchorLocId: prev.anchorLocId || map.player.locId || map.scenes[0]?.id || "",
        }));
      } catch (e) {
        setErr(errorMessage(e));
      }
    })();
    const saved = window.localStorage.getItem(TOKEN_KEY) ?? "";
    setToken(saved);
    if (saved) void loadDrafts(saved);
  }, [loadDrafts, roomId]);

  const onTokenChange = (value: string) => {
    setToken(value);
    window.localStorage.setItem(TOKEN_KEY, value);
  };

  const submitCreate = async () => {
    const name = form.name.trim();
    const idea = form.idea.trim();
    if (name.length < 2 || name.length > 24) return setErr("名称需 2–24 字");
    if (idea.length < 10 || idea.length > 300) return setErr("想法需 10–300 字");
    if (!form.anchorLocId) return setErr("请选择锚点场景");
    setBusy("create");
    setErr("");
    try {
      const draft = await createDraft({ name, idea, anchorLocId: form.anchorLocId });
      setCreated(draft);
      setQueryId(draft.id);
      setForm((prev) => ({ ...prev, name: "", idea: "" }));
      push("system", `已提交场景草案「${draft.name}」（${draft.id}），等待管理员审核。`);
      if (token) await loadDrafts(token);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submitQuery = async () => {
    const id = queryId.trim();
    if (!id) return setErr("请输入草案 id");
    setBusy("query");
    setErr("");
    try {
      setQueried(await getDraft(id));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const runAdmin = async (label: string, fn: () => Promise<void>) => {
    if (!token) return setErr("先填写管理员 token");
    setBusy(label);
    setErr("");
    try {
      await fn();
      await loadDrafts(token);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onReview = (draft: SceneDraft, action: "approve" | "reject") =>
    void runAdmin(`review:${draft.id}`, async () => {
      await reviewDraft(draft.id, token, { action });
    });

  const onPublish = (draft: SceneDraft, action: "approve" | "reject") =>
    void runAdmin(`publish:${draft.id}`, async () => {
      const res = await publishDraft(draft.id, token, { action });
      if (action === "approve") {
        push("system", `场景「${res.scene?.name ?? draft.name}」已发布，可在地图中前往。`);
        onRefreshState();
      }
    });

  const onRetry = (draft: SceneDraft) =>
    void runAdmin(`generate:${draft.id}`, async () => {
      await retryGenerate(draft.id, token);
    });

  const disabled = busy !== null;

  return (
    <div className="drafts-panel">
      <section className="drafts-col">
        <h2>造一个场景</h2>
        <p className="muted">玩家提案 → 管理员审核 → AI 生成草案 → 管理员审核发布。坐标由服务端按锚点随机生成。</p>
        <div className="field">
          <label htmlFor="draft-name">名称（2–24 字）</label>
          <input
            id="draft-name"
            value={form.name}
            maxLength={24}
            placeholder="例如：旧实验楼后门"
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="draft-idea">想法（10–300 字）</label>
          <textarea
            id="draft-idea"
            value={form.idea}
            maxLength={300}
            placeholder="描述你希望这里发生什么、有什么线索或人物。"
            onChange={(e) => setForm((prev) => ({ ...prev, idea: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="draft-anchor">锚点场景</label>
          <select
            id="draft-anchor"
            value={form.anchorLocId}
            onChange={(e) => setForm((prev) => ({ ...prev, anchorLocId: e.target.value }))}
          >
            {anchors.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn primary" onClick={() => void submitCreate()} disabled={disabled}>
          提交草案
        </button>
        {created && (
          <div className="created">
            <DraftCard draft={created} anchorName={sceneName(anchors, created.anchorLocId)} disabled admin={false} />
          </div>
        )}

        <h2>查询草案</h2>
        <div className="query-row">
          <input
            value={queryId}
            placeholder="draft_xxxxxxxx"
            onChange={(e) => setQueryId(e.target.value)}
          />
          <button className="btn" onClick={() => void submitQuery()} disabled={disabled}>
            查询
          </button>
        </div>
        {queried && (
          <DraftCard draft={queried} anchorName={sceneName(anchors, queried.anchorLocId)} disabled admin={false} />
        )}
      </section>

      <section className="drafts-col">
        <h2>管理员审核</h2>
        <p className="muted">token 存在 localStorage，请求头 x-admin-token（未配置 GALGAME_ADMIN_TOKEN 时看服务端启动日志）。</p>
        <div className="token-row">
          <input
            type="password"
            value={token}
            placeholder="管理员 token"
            onChange={(e) => onTokenChange(e.target.value)}
          />
          <button className="btn" onClick={() => void loadDrafts(token)} disabled={disabled || !token}>
            刷新列表
          </button>
        </div>
        {err && <div className="err">{err}</div>}
        {busy && <div className="muted">处理中：{busy}</div>}
        {drafts === null ? (
          <p className="muted">填入管理员 token 后加载草案列表。</p>
        ) : drafts.length === 0 ? (
          <p className="muted">暂无草案。</p>
        ) : (
          <div className="drafts-list">
            {drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                anchorName={sceneName(anchors, draft.anchorLocId)}
                disabled={disabled}
                admin
                onReview={(action) => onReview(draft, action)}
                onPublish={(action) => onPublish(draft, action)}
                onRetry={() => onRetry(draft)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
