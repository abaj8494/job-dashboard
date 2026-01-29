#!/bin/bash
# JobSync Email Sync Hook
# This script is called by notmuch post-new hook to sync job-related emails

# Load config from ~/.jobsync/config (works even when run from Emacs)
CONFIG_FILE="${HOME}/.jobsync/config"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

# Configuration (fallback to env vars or defaults)
JOBSYNC_API_URL="${JOBSYNC_API_URL:-http://localhost:3000/api/email-sync}"
JOBSYNC_API_KEY="${JOBSYNC_API_KEY:-}"
LOG_DIR="${HOME}/.jobsync"
LOG_FILE="${LOG_DIR}/email-sync.log"
MAX_LOG_SIZE=1048576  # 1MB

# Create log directory if needed
mkdir -p "$LOG_DIR"

# Rotate log if too large
if [ -f "$LOG_FILE" ] && [ $(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null) -gt $MAX_LOG_SIZE ]; then
    mv "$LOG_FILE" "${LOG_FILE}.old"
fi

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "Post-new hook triggered"

# Check if API key is set
if [ -z "$JOBSYNC_API_KEY" ]; then
    log "ERROR: JOBSYNC_API_KEY environment variable not set"
    exit 1
fi

# Check if there are any new emails for monitored accounts
NEW_COUNT=$(notmuch count 'tag:new AND (from:j@abaj.ai OR to:j@abaj.ai OR from:aayushbajaj7@gmail.com OR to:aayushbajaj7@gmail.com) AND NOT tag:spam AND NOT tag:trash AND NOT tag:jobsync-processed' 2>/dev/null)

if [ -z "$NEW_COUNT" ] || [ "$NEW_COUNT" -eq 0 ]; then
    log "No new emails for monitored accounts"
    exit 0
fi

log "Found $NEW_COUNT new emails, triggering sync"

# Call JobSync API
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$JOBSYNC_API_URL" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $JOBSYNC_API_KEY" \
    --max-time 120 \
    2>&1)

# Parse response
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    log "Sync successful: $BODY"
else
    log "Sync failed (HTTP $HTTP_CODE): $BODY"
fi
