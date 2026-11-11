# JobSync Production Deployment Guide

> **Status (2026-11):** jobs.abaj.ai is where the person sees what they applied to and when.
> The Mac's notmuch-hook classifier files job mail there with no review step, and the Chrome
> extension lists and saves jobs there (see Local Machine Setup). On the abaj.ai VPS the site is served by **OpenResty**, not stock
> nginx: the vhost is `/usr/local/openresty/nginx/conf/conf.d/15-jobs.conf`, reloaded with
> `systemctl reload openresty`. The nginx paths below describe the original setup.

Deploy JobSync to your server at `jobs.abaj.ai` with Docker and nginx.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    jobs.abaj.ai (VPS)                           │
│                                                                 │
│  ┌─────────────┐     ┌──────────────────────────────────────┐  │
│  │   nginx     │────▶│  Docker: JobSync                     │  │
│  │  (SSL/proxy)│     │  - Next.js app                       │  │
│  └─────────────┘     │  - SQLite at /data/dev.db            │  │
│                      │  - No Ollama needed                   │  │
│                      └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                   ▲
                                   │ HTTPS POST /api/email-sync
                                   │ (pre-classified emails)
┌──────────────────────────────────┴──────────────────────────────┐
│                    Local Machine                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   notmuch    │───▶│ claude CLI   │───▶│  local-sync.js   │  │
│  │   (mail)     │    │ (headless)   │    │  (sends to VPS)  │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Server Setup

### 1. Prerequisites

On your VPS:
```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install nginx
sudo apt install nginx certbot python3-certbot-nginx
```

### 2. Clone and Configure

```bash
# Clone the repository
git clone https://github.com/yourusername/jobsync.git /opt/jobsync
cd /opt/jobsync

# Create production environment file
cat > .env.production << 'EOF'
# Authentication
AUTH_SECRET=<generate-with: openssl rand -base64 32>
USER_EMAIL=your@email.com
USER_PASSWORD=<your-secure-password>

# URLs
NEXTAUTH_URL=https://jobs.abaj.ai
AUTH_TRUST_HOST=true

# Database (SQLite inside container)
DATABASE_URL=file:/data/dev.db

# Email sync (generate new key for production)
EMAIL_SYNC_API_KEY=<generate-with: openssl rand -base64 32>
MONITORED_EMAILS=j@abaj.ai,aayushbajaj7@gmail.com

# Ollama not needed on server (local machine handles classification)
# OLLAMA_BASE_URL=
EOF
```

### 3. Docker Compose for Production

Create `docker-compose.prod.yml`:
```yaml
services:
  app:
    container_name: jobsync
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "127.0.0.1:3000:3000"  # Only expose to localhost (nginx will proxy)
    env_file:
      - .env.production
    volumes:
      - ./data:/data           # SQLite database
      - ./logs:/app/logs       # Application logs (if configured)
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/api/email-sync"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### 4. Nginx Configuration

Create `/etc/nginx/sites-available/jobs.abaj.ai`:
```nginx
server {
    listen 80;
    server_name jobs.abaj.ai;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name jobs.abaj.ai;

    # SSL certificates (managed by certbot)
    ssl_certificate /etc/letsencrypt/live/jobs.abaj.ai/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jobs.abaj.ai/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logging
    access_log /var/log/nginx/jobs.abaj.ai.access.log;
    error_log /var/log/nginx/jobs.abaj.ai.error.log;

    # Proxy to Docker container
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }

    # Larger body size for file uploads (resumes)
    client_max_body_size 10M;
}
```

Enable and get SSL:
```bash
sudo ln -s /etc/nginx/sites-available/jobs.abaj.ai /etc/nginx/sites-enabled/
sudo nginx -t
sudo certbot --nginx -d jobs.abaj.ai
sudo systemctl reload nginx
```

### 5. Deploy

```bash
cd /opt/jobsync

# Build and start
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# Check logs
docker compose -f docker-compose.prod.yml logs -f

# Check health
curl -s https://jobs.abaj.ai/api/email-sync | jq
```

### 6. Updates

```bash
cd /opt/jobsync
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

---

## Local Machine Setup

A notmuch hook classifies job mail with Claude, tags it in notmuch, and sends each job-related
result to jobs.abaj.ai, which files it: it creates the job or links to it, dated by the mail, and
moves its status forward (`src/lib/email/auto-file.ts`). The JobSync Chrome extension lists the
server's jobs (see the jobsync-chrome-extension README).

### 1. Configuration

`~/.jobsync/config` is read, not sourced; only these variables are taken from it:

```bash
export MONITORED_EMAILS="j@abaj.ai,aayushbajaj7@gmail.com"
export JOBSYNC_API_URL="https://jobs.abaj.ai/api/email-sync"   # https only (http is refused except localhost)
export JOBSYNC_API_KEY="..."                                    # the server's EMAIL_SYNC_API_KEY
export JOBSYNC_SERVER_SYNC=1    # send to the server; without it results wait in the outbox
```

Optional overrides go in the environment:

```bash
# CLAUDE_BIN="$HOME/.local/bin/claude"      # Claude Code CLI, logged in to the subscription
# JOBSYNC_CLAUDE_MODEL="opus"
# JOBSYNC_CONFIDENCE_THRESHOLD="0.8"        # below this, stage 2 reads a short excerpt
# JOBSYNC_SINCE="2026-10-09"                # oldest mail date considered
# JOBSYNC_MAX_PER_RUN="100"                 # messages per run (0 = all)
# JOBSYNC_CONCURRENCY="2"                   # parallel CLI calls
```

### 2. How classification works

`scripts/jobsync-mail-classify.js` (library: `scripts/lib/mail-classifier.js`):

1. **Stage 0, local:** mail tagged by earlier hook steps (Finance, alpaca, tern, ...),
   transactional sender domains, and the SEEK/LinkedIn/Indeed rules. No Claude call.
2. **Stage 1, headers only:** direction, From, To, Subject, Date and whether it is list mail.
   Claude never sees the body here.
3. **Stage 2, short excerpt:** only when stage 1 is unsure, or an application still lacks a
   company or title. At most 1,500 characters, with quoted history removed and links, addresses
   and long numbers replaced.

Calls use the headless CLI (`claude -p --output-format json --tools "" --json-schema ...`) on the
owner's claude.ai subscription. The script removes `ANTHROPIC_API_KEY` from its environment and
refuses to run unless `claude auth status` reports `authMethod=claude.ai`. Usage per call goes
to `~/.jobsync/claude-usage.jsonl`.

Results:
- tag `jobsync/<type>` (job_application, job_response, interview, rejection, offer,
  follow_up, other). A failed classification leaves the mail untagged for the next run.
- each job-related result is queued in `~/.jobsync/server-outbox.json` and POSTed to
  `/api/email-sync` with extracted fields only: messageId, mail date, type, confidence, company,
  title, location. No subject, sender or body leaves the Mac, and the server stores no mail bodies.
  The server confirms each import; confirmed mail is tagged `jobsync-server`, and anything
  unconfirmed (server down, offline, old build) stays queued for the next run. The server skips
  a messageId it already has, so resends are harmless.
- the server files a result without review when the classifier is at or above its threshold.
  It stays **pending** only when it cannot be filed: no company, no job yet and no title, several
  jobs at that company that the title does not tell apart, or the classifier still unsure after
  the excerpt. Pending mail shows on jobs.abaj.ai under Email Imports, labelled from the extracted
  fields (for example "Rejection: Acme (from mail)") with the reason, and stays tagged in notmuch.
- owner corrections (`jobsync-was/<original>` tags from the Emacs helpers) are recorded in
  `~/.jobsync/corrections.json` (headers only) and sent to the server: corrected to `other`
  deletes the import (one already filed to a job is kept; change the job on the site), corrected
  to a job type refiles it with that type.
- `--refile` sends job mail tagged before the server step existed (`jobsync/<job type>` without
  `jobsync-server`), re-reading only the details.
- `~/.jobsync/mail-classify.log` holds message ids, labels, stages and cost, never subjects,
  senders or body text.

### 3. Notmuch hook

The live hook is `~/Maildir/.notmuch/hooks/post-new` (notmuch's `database.hook_dir`), a stow
symlink into the dotfiles repo. Its JobSync step runs the script in the background, so
`notmuch new` is not held up. A lock in `~/.jobsync/mail-classify.lock` makes an overlapping
run exit at once.

### 4. Test

```bash
claude auth status                                   # logged in, authMethod claude.ai
node scripts/jobsync-mail-classify.js --dry-run --limit 5   # ids and labels only; no tags, nothing sent
npx jest __tests__/mail-classifier.spec.js
```

---

## Monitoring & Debugging

### Docker Logs

```bash
# Live logs
docker compose -f docker-compose.prod.yml logs -f # Last 100 lines docker compose -f docker-compose.prod.yml logs --tail 100 # Specific service docker logs jobsync --tail 100 -f ```

### Database Access

```bash
# Shell into container docker exec -it jobsync sh # Query database sqlite3 /data/dev.db "SELECT COUNT(*) FROM EmailImport WHERE status='pending';" # Or from host (if you mounted the data directory) sqlite3 ./data/dev.db ".tables" ```

### Health Checks

```bash
# API health
curl -s https://jobs.abaj.ai/api/email-sync | jq

# Full health check script
cat > /opt/jobsync/healthcheck.sh << 'EOF'
#!/bin/bash
response=$(curl -s -o /dev/null -w "%{http_code}" https://jobs.abaj.ai/signin)
if [ "$response" != "200" ]; then
    echo "JobSync is DOWN! HTTP $response"
    # Add alerting here (email, Slack, etc.)
    exit 1
fi
echo "JobSync is UP"
EOF
chmod +x /opt/jobsync/healthcheck.sh

# Add to cron for monitoring
# */5 * * * * /opt/jobsync/healthcheck.sh
```

### Local Sync Logs

```bash
# View local sync logs
tail -f ~/.jobsync/local-sync.log
tail -f ~/.jobsync/email-sync.log
```

---

## Resource Usage

Typical resource usage for a single-user deployment:

| Resource | Usage |
|----------|-------|
| RAM | 200-400 MB |
| CPU | < 5% idle, spikes during requests |
| Disk | ~500 MB (app) + database size |
| Network | Minimal (text-based app) |

A 1GB VPS ($5-6/month) should be sufficient.

---

## Backup

```bash
# Backup database
docker exec jobsync sqlite3 /data/dev.db ".backup /data/backup.db"
cp ./data/backup.db ~/backups/jobsync-$(date +%Y%m%d).db

# Or from cron
0 2 * * * docker exec jobsync sqlite3 /data/dev.db ".backup /data/backup-daily.db"
```

---

## Troubleshooting

### Container won't start
```bash
docker compose -f docker-compose.prod.yml logs
# Check for missing env vars or permission issues
```

### Database locked errors
```bash
# Only one process should access SQLite at a time
# Ensure no concurrent migrations are running
```

### 502 Bad Gateway
```bash
# Check if container is running
docker ps
# Check nginx config
sudo nginx -t
# Check container logs
docker logs jobsync
```

### Email sync not working
```bash
# Test API key
curl -X POST https://jobs.abaj.ai/api/email-sync \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"imports":[]}'
# Should return: {"message":"Pre-classified import completed",...}
```
