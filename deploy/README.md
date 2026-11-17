# 试用部署（Docker + 宿主机 Nginx）

目标：单机单实例，`https://<公网IP>/`，应用内邀请注册 + Cookie 会话。

**域名隔离**：游戏 server 只匹配 `server_name <公网IP>`；443 的 `default_server` 是**404 catch-all**。已有域名（如 `huaaaji.cloud`）仍由原来的 `server_name` 命中 WordNote；任何其他 Host（包括解析到同一 IP 的域名）都不会进入游戏。本次没有修改 DNS。

## 1. 准备

```bash
sudo mkdir -p /opt/ecust-galgame
sudo chown "$USER":"$USER" /opt/ecust-galgame
git clone --branch <branch> --depth 1 <repo-url> /opt/ecust-galgame/app
mkdir -p /opt/ecust-galgame/data
sudo chown -R 1000:1000 /opt/ecust-galgame/data
```

Web 静态文件由本地构建后同步到 `/opt/ecust-galgame/web`：

```bash
npm run build:web
rsync -az --delete apps/web/dist/ <server>:/opt/ecust-galgame/web/
```

## 2. `.env`（放在 `/opt/ecust-galgame/app/.env`，权限 600）

```dotenv
GALGAME_HOST=0.0.0.0
GALGAME_PORT=8787
GALGAME_DATA_DIR=/app/data
GALGAME_AUTH_REQUIRED=1
GALGAME_INVITE_CODE=<强随机邀请码>
GALGAME_SECURE_COOKIES=1
GALGAME_SESSION_TTL_DAYS=7
GALGAME_TRUST_USER_HEADER=0
GALGAME_ADMIN_TOKEN=<强随机令牌>
# 可选：模型/审核；不配则离线叙述、NoopAudit
# GALGAME_LLM_BASE_URL=...
# GALGAME_LLM_MODEL=...
# GALGAME_LLM_API_KEY=...
# GALGAME_AUDIT_BASE_URL=...
# GALGAME_AUDIT_MODEL=...
# GALGAME_AUDIT_API_KEY=...
```

## 3. 应用容器

```bash
cd /opt/ecust-galgame/app
sudo docker compose up -d --build
sudo docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/health
```

## 4. Nginx + 自签证书（无域名，仅 IP 访问）

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/ecust-galgame.key \
  -out /etc/nginx/ssl/ecust-galgame.crt \
  -subj "/CN=<公网IP>" \
  -addext "subjectAltName=IP:<公网IP>"
sudo chmod 600 /etc/nginx/ssl/ecust-galgame.key

sudo cp deploy/nginx-ecust-galgame.conf /etc/nginx/sites-available/ecust-galgame
sudo ln -sfn /etc/nginx/sites-available/ecust-galgame /etc/nginx/sites-enabled/ecust-galgame
sudo nginx -t && sudo systemctl reload nginx
```

## 5. 冒烟

```bash
curl -kI https://<公网IP>/
# 域名必须仍落到原站点，而不是游戏
curl -k -sS --resolve huaaaji.cloud:443:<公网IP> https://huaaaji.cloud/ | grep -o "<title>[^<]*"
curl -k https://<公网IP>/api/v1/health

# 注册（邀请码来自 .env）；记下 set-cookie
curl -k -i -X POST https://<公网IP>/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"password123","inviteCode":"<邀请码>"}'

# 带 Cookie 建一个房间
curl -k -X POST https://<公网IP>/api/v1/rooms \
  -H 'content-type: application/json' -b '<cookie>' -d '{"mode":"solo"}'
```

## 6. 注意

- 单实例；`FileStore` 没有多进程锁，不要扩副本。
- `data/` 是唯一持久卷，备份它。
- 自签证书浏览器会警告；HTTPS 是 Cookie `Secure` 和密码传输的前提。若只想组内使用，可再加 UFW 源 IP 白名单或 VPN。
- `GALGAME_AUTH_REQUIRED=1` 后，旧 `X-User-Id` 不再生效；每人一个账号，清 localStorage 不影响账号。
- `/api/v1/settings/` 已在 Nginx 层封掉；模型 key 统一走服务端 `.env`。
