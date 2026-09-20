# ── Stage 0: capture git commit metadata for app event backfill ──────────────
# Runs on the build host where .git is available; produces a single small JSON
# file so the runtime image never needs .git or a git binary.
FROM python:3.12-slim AS git-meta
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY .git ./.git
RUN git log --format="%H|%aI|%aN|%s" --no-merges -n 100 2>/dev/null > /tmp/gl.txt; \
    python3 -c "import sys,json;lines=open('/tmp/gl.txt').read().splitlines();entries=[dict(zip(['hash','date','author','subject'],l.split('|',3))) for l in lines if len(l.split('|',3))==4];print(json.dumps(entries))" \
    > /git_commits.json 2>/dev/null || printf '[]' > /git_commits.json

# ── Stage 1: build the React interface ───────────────────────────────────────
# A separate stage so node and 300 MB of node_modules never reach the runtime image.
# Only frontend/dist is copied forward. A development server is not the production
# serving process: FastAPI serves these files itself, see app_asset in server.py.
FROM node:22-slim AS frontend
WORKDIR /build
# package.json and the lockfile first, so a source-only change reuses the install layer.
COPY frontend/package.json frontend/package-lock.json ./
# `npm ci` and not `npm install`: it installs exactly the committed lockfile and fails
# if the two disagree, which is what makes a build reproducible.
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# tsc runs first (the `build` script chains it), so a type error fails the image build
# rather than shipping.
RUN npm run build

# ── Stage 2: the application ─────────────────────────────────────────────────
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssh-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py psn_auth.py psn_messaging.py roast_bot.py portal.py psn_data.py mattermost.py mm_tokens.py video_jobs.py clips.py clip_store.py whatsapp_analytics.py giveaway.py watch.py assistant.py facts.py chat_history.py psn_ai.py wa_ai.py crcmz_identity.py soundboard.py mcp_server.py game_history.py mcp_oauth.py memory_store.py coach.py app_events.py watchparty_events.py favicon.png crcmz-logo.png footer-avatar.png ./
# Documentation files — indexed by the semantic memory layer (memory_store.py).
COPY docs/ ./docs/
# Git commit manifest — used by app_events.backfill_from_git() since .git is
# not present in the runtime image.
COPY --from=git-meta /git_commits.json ./git_commits.json
# Must land at frontend/dist — that is the path _APP_DIST resolves in server.py.
COPY --from=frontend /build/dist ./frontend/dist
RUN mkdir -p /data
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/health')" || exit 1
CMD ["sh", "-c", "if [ -n \"$AI_CONTROLLER_SSH_KEY\" ]; then mkdir -p /home/opti3/.ssh && printf '%s' \"$AI_CONTROLLER_SSH_KEY\" | base64 -d > /home/opti3/.ssh/id_ed25519_aicontroller && chmod 600 /home/opti3/.ssh/id_ed25519_aicontroller; fi && uvicorn server:app --host 0.0.0.0 --port 3000"]
