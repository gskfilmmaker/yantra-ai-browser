FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /app

# Install Node dependencies (Playwright browsers already in base image)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure data directory exists for SQLite DB
RUN mkdir -p /app/data

EXPOSE 3737
CMD ["node", "index.js"]
