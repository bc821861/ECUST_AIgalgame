/**
 * 登录 / 邀请注册入口。身份只在服务端 HttpOnly Cookie 里；
 * 这里不写 localStorage、不保存 token，登录成功只把用户对象交给 App。
 */
import { useState, type FormEvent } from "react";
import { login, register } from "./api-auth.ts";
import type { AuthUser } from "./api-auth.ts";
import { GameError } from "./http.ts";

type Mode = "login" | "register";

export default function AuthScreen({ onAuthed }: { onAuthed: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (!name || !password) {
      setError("请填写用户名和密码");
      return;
    }
    if (mode === "register" && !inviteCode.trim()) {
      setError("请填写邀请码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const user =
        mode === "login" ? await login(name, password) : await register(name, password, inviteCode.trim());
      onAuthed(user);
    } catch (err) {
      setError(err instanceof GameError ? `${err.code}：${err.message}` : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-mark" aria-hidden="true" />
      <div className="auth-card">
        <p className="title-mark">ECUST · 奉贤校区 · 九月</p>
        <h1 className="auth-title">
          登录 <span>AI 校园</span>
        </h1>
        <p className="auth-sub">开发内测 · 账号用于隔离存档与 NPC 记忆</p>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={`auth-tab${mode === "login" ? " active" : ""}`}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={`auth-tab${mode === "register" ? " active" : ""}`}
            onClick={() => {
              setMode("register");
              setError("");
            }}
          >
            邀请注册
          </button>
        </div>

        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              maxLength={24}
              placeholder="3–24 位小写字母 / 数字 / _ / -"
              autoFocus
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              maxLength={128}
              placeholder="至少 8 位"
            />
          </label>
          {mode === "register" && (
            <label className="field">
              <span>邀请码</span>
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                autoComplete="off"
                placeholder="向管理员索取"
              />
            </label>
          )}
          {error && <div className="err auth-err">{error}</div>}
          <button type="submit" className="btn primary auth-submit" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        <p className="muted auth-note">
          {mode === "login" ? "还没有账号？切到「邀请注册」。" : "注册需要有效邀请码；用户名注册后不可改名。"}
        </p>
      </div>
    </div>
  );
}
