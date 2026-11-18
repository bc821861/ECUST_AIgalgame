import type { SceneDraft } from "./api.ts";
import { draftStatusLabel, formatTime } from "./ui.ts";

interface Props {
  draft: SceneDraft;
  anchorName: string;
  disabled: boolean;
  admin: boolean;
  onReview?: (action: "approve" | "reject") => void;
  onPublish?: (action: "approve" | "reject") => void;
  onRetry?: () => void;
}

/** 草案卡片：状态 + 生成预览 + 按状态机显示管理员按钮（docs/06 §5） */
export default function DraftCard({
  draft,
  anchorName,
  disabled,
  admin,
  onReview,
  onPublish,
  onRetry,
}: Props) {
  const generated = draft.generated;
  return (
    <article className="draft">
      <header>
        <span className={`pill ${draft.status}`}>{draftStatusLabel(draft.status)}</span>
        <strong>{draft.name}</strong>
        <span className="muted draft-id">{draft.id}</span>
      </header>
      <div className="muted">
        锚点：{anchorName} · 坐标 ({draft.coords?.x ?? "?"}, {draft.coords?.y ?? "?"}) · 更新{" "}
        {formatTime(draft.updatedAt)}
      </div>
      <p className="idea">{draft.idea}</p>
      {draft.error && <div className="draft-err">生成失败：{draft.error}</div>}
      {generated && (
        <div className="preview">
          <div className="preview-title">生成预览：{generated.name}</div>
          <p>{generated.desc}</p>
          <div className="chips">
            {(generated.tags ?? []).map((tag) => (
              <span key={tag} className="chip tag">
                {tag}
              </span>
            ))}
          </div>
          {(generated.links ?? []).length > 0 && (
            <div className="muted">
              链接：{generated.links.map((link) => link.label ?? link.id).join("、")}
            </div>
          )}
          {(generated.dialogues ?? []).map((dialogue) => (
            <div key={`${dialogue.title}:${dialogue.npcId}`} className="dlg">
              <div className="muted">
                {dialogue.title}（{dialogue.npcId}）
              </div>
              {(dialogue.lines ?? []).map((line, i) => (
                <p key={i} className="line npc">
                  {line}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      {admin && (
        <div className="draft-actions">
          {draft.status === "pending_review" && onReview && (
            <>
              <button className="btn primary" disabled={disabled} onClick={() => onReview("approve")}>
                通过
              </button>
              <button className="btn danger" disabled={disabled} onClick={() => onReview("reject")}>
                拒绝
              </button>
            </>
          )}
          {draft.status === "approved" && (
            <>
              {onRetry && (
                <button className="btn" disabled={disabled} onClick={onRetry}>
                  重试生成
                </button>
              )}
              {onPublish && (
                <button className="btn danger" disabled={disabled} onClick={() => onPublish("reject")}>
                  拒绝
                </button>
              )}
            </>
          )}
          {draft.status === "generated_pending_review" && onPublish && (
            <>
              <button className="btn primary" disabled={disabled} onClick={() => onPublish("approve")}>
                发布
              </button>
              <button className="btn danger" disabled={disabled} onClick={() => onPublish("reject")}>
                拒绝
              </button>
            </>
          )}
          {draft.status === "generating" && <span className="muted">AI 生成中…</span>}
          {draft.status === "published" && <span className="muted">已发布</span>}
          {draft.status === "rejected" && <span className="muted">已拒绝</span>}
        </div>
      )}
      <div className="muted history">
        历史：
        {(draft.history ?? []).map((h) => `${h.actor}:${h.action}`).join(" → ") || "—"}
      </div>
    </article>
  );
}
