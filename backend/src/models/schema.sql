-- Yantra SaaS — PostgreSQL schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT        NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT        NOT NULL,
  plan          TEXT        NOT NULL DEFAULT 'free',  -- free | pro | team
  stripe_customer_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Teams ─────────────────────────────────────────────────────────────────────
CREATE TABLE teams (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT        NOT NULL,
  owner_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan       TEXT        NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id    UUID NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',     -- owner | admin | member
  PRIMARY KEY (team_id, user_id)
);

-- ── Agents ────────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id       UUID        REFERENCES teams(id) ON DELETE SET NULL,
  name          TEXT        NOT NULL,
  avatar        TEXT,
  description   TEXT,
  system_prompt TEXT,
  tools         JSONB       NOT NULL DEFAULT '[]',
  memory_scope  TEXT        NOT NULL DEFAULT 'session',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   UUID        REFERENCES agents(id) ON DELETE SET NULL,
  title      TEXT,
  messages   JSONB       NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Usage events (metering) ───────────────────────────────────────────────────
CREATE TABLE usage_events (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   UUID        REFERENCES sessions(id) ON DELETE SET NULL,
  agent_id     UUID        REFERENCES agents(id)   ON DELETE SET NULL,
  model        TEXT        NOT NULL,
  tokens_used  INTEGER     NOT NULL DEFAULT 0,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON usage_events (user_id, ts);

-- ── Subscriptions ─────────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT       UNIQUE,
  plan                  TEXT        NOT NULL DEFAULT 'free',
  status                TEXT        NOT NULL DEFAULT 'active',  -- active | past_due | canceled
  current_period_end    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Audit log ─────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  session_id UUID        REFERENCES sessions(id) ON DELETE SET NULL,
  agent_id   UUID        REFERENCES agents(id)   ON DELETE SET NULL,
  action     TEXT        NOT NULL,
  details    JSONB,
  risk       TEXT,       -- low | medium | high
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_log (user_id, ts);
