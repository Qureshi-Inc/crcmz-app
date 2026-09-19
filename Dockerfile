FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssh-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py psn_auth.py psn_messaging.py roast_bot.py portal.py psn_data.py mattermost.py video_jobs.py clips.py clip_store.py whatsapp_analytics.py giveaway.py watch.py assistant.py facts.py chat_history.py psn_ai.py wa_ai.py crcmz_identity.py soundboard.py mcp_server.py game_history.py mcp_oauth.py favicon.png crcmz-logo.png footer-avatar.png ./
RUN mkdir -p /data
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/health')" || exit 1
CMD ["sh", "-c", "if [ -n \"$AI_CONTROLLER_SSH_KEY\" ]; then mkdir -p /home/opti3/.ssh && printf '%s' \"$AI_CONTROLLER_SSH_KEY\" | base64 -d > /home/opti3/.ssh/id_ed25519_aicontroller && chmod 600 /home/opti3/.ssh/id_ed25519_aicontroller; fi && uvicorn server:app --host 0.0.0.0 --port 3000"]
