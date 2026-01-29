# JobSync Production Deployment Guide

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
│  │   notmuch    │───▶│   Ollama     │───▶│  local-sync.ts   │  │
│  │   (mail)     │    │   (LLM)      │    │  (sends to VPS)  │  │
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

Configure your local machine to sync emails to the server.

### 1. Update Environment

Add to `~/.jobsync/config`:
```bash
# Remote server (production)
JOBSYNC_API_KEY="<same-key-as-server-.env.production>"
JOBSYNC_API_URL="https://jobs.abaj.ai/api/email-sync"

# Ollama (local)
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="llama3.2"

# Email accounts
MONITORED_EMAILS="j@abaj.ai,aayushbajaj7@gmail.com"
```

### 2. Install Local Sync Dependencies

```bash
cd /path/to/jobsync
npm install  # Ensure mailparser and other deps are installed
```

### 3. Update Notmuch Hook

Edit `~/Maildir/.notmuch/hooks/post-new`:
```bash
#!/bin/bash
# Sync to remote JobSync server

# Source config
source ~/.jobsync/config

# Use the TypeScript local sync script
cd /Users/aayushbajaj/Documents/code-private/jobsync
npx ts-node scripts/jobsync-local-sync.ts &
```

Or for the simpler shell-based approach (calls local API which uses Ollama):
```bash
#!/bin/bash
# For local development (when running npm run dev locally)
/Users/aayushbajaj/Documents/code-private/jobsync/scripts/jobsync-email-hook.sh &
```

### 4. Test Local Sync

```bash
# Make sure Ollama is running
ollama serve &

# Test the sync
cd /path/to/jobsync
JOBSYNC_API_KEY="your-key" \
JOBSYNC_API_URL="https://jobs.abaj.ai/api/email-sync" \
npx ts-node scripts/jobsync-local-sync.ts
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
