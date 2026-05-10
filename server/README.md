# Yantra Backend Server

Run the Yantra AI agent on a cloud server — no Mac required.

## Quick start (local)

```bash
cd server
npm install
npx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...
npm start
# Open http://localhost:3737
```

## Docker (recommended for VPS)

```bash
cd server
cp .env.example .env        # add your API keys
docker-compose up -d
# Open http://your-server-ip:3737
```

## .env.example

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...       # optional
PORT=3737
```

## VPS setup (Ubuntu 22.04)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone and start
git clone https://github.com/gskfilmmaker/yantra-ai-browser
cd yantra-ai-browser/server
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
docker-compose up -d

# Optional: reverse proxy with nginx + HTTPS
# Point your domain to the VPS and use certbot
```

## Architecture

```
Browser (web UI)  ←→  Express server (port 3737)
                           ↕ SSE streaming
                      Agent loop (llmClient pattern)
                           ↕ tool calls
                      Playwright (headless Chromium)
                           ↕ persistence
                      SQLite (data/yantra.db)
```

Benefits over desktop Electron:
- Mac never hangs — agent runs on server
- Tasks continue when Mac sleeps or lid closes
- Sessions survive crashes (SQLite-backed checkpoints)
- Access from any device at http://your-server:3737
