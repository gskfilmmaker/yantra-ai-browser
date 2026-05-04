# Vercel Deployment Guide

## Prerequisites

- Node.js 20+
- Vercel CLI: `npm i -g vercel`
- A Vercel account linked to the `gskfilmmaker` GitHub org

---

## Quick Start

```bash
cd apps/web
npm install
vercel dev          # local development on :3000
vercel              # deploy to preview
vercel --prod       # deploy to production
```

---

## Environment Variables

Set these in the Vercel dashboard under **Project → Settings → Environment Variables**,
or in `.env.local` for local development (never commit this file).

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Server-side Anthropic key for proxied LLM calls |
| `OPENAI_API_KEY` | No | Optional OpenAI fallback |
| `SYNC_HMAC_SECRET` | Yes | 32-byte hex secret for verifying delta payloads from desktop |
| `NEXTAUTH_SECRET` | Yes | Random 32-char string for session signing |
| `NEXTAUTH_URL` | Yes | Public URL, e.g. `https://yantra.vercel.app` |
| `KV_URL` | Auto | Set automatically when Vercel KV is linked |
| `BLOB_READ_WRITE_TOKEN` | Auto | Set automatically when Vercel Blob is linked |

Copy `.env.example` to `.env.local` and fill in values for local dev.

---

## Project Structure

```
apps/web/
├── app/                  # Next.js App Router
│   ├── layout.tsx
│   ├── page.tsx          # redirect to /dashboard
│   ├── dashboard/
│   │   └── page.tsx      # memory browser, routine editor
│   ├── share/
│   │   └── [id]/
│   │       └── page.tsx  # public transcript viewer
│   └── api/
│       ├── sync/
│       │   ├── memory/
│       │   │   └── route.ts   # POST: receive memory delta
│       │   └── state/
│       │       └── route.ts   # GET: return changes since timestamp
│       ├── run/
│       │   └── route.ts       # POST: headless agent execution
│       └── auth/
│           └── [...nextauth]/
│               └── route.ts
├── components/
├── lib/
│   ├── db.ts             # Vercel KV helpers
│   ├── blob.ts           # Vercel Blob helpers
│   └── hmac.ts           # payload verification
├── public/
├── .env.example
├── next.config.js
├── package.json
└── tsconfig.json
```

---

## Vercel Storage Setup

### KV (Redis-compatible)

```bash
vercel storage connect kv
```

Used for: rate limiting, session cache, sync state pointers.

### Blob

```bash
vercel storage connect blob
```

Used for: agent run transcripts, screenshots.

---

## Deployment Checklist

- [ ] `SYNC_HMAC_SECRET` set and matches `YANTRA_SYNC_SECRET` in `.env.local` on each desktop install
- [ ] `ANTHROPIC_API_KEY` set in Vercel environment (Production + Preview)
- [ ] `NEXTAUTH_SECRET` and `NEXTAUTH_URL` set
- [ ] KV storage linked
- [ ] Blob storage linked
- [ ] Custom domain configured in Vercel dashboard
- [ ] CORS origin allowlist updated in `next.config.js` to include the custom domain

---

## CI/CD

Vercel auto-deploys on every push to `main`. Preview deployments are created
for every pull request. No additional CI configuration is needed.

To run the Next.js build locally before pushing:

```bash
cd apps/web && npm run build
```
