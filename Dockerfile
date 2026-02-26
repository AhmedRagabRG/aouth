# ── Stage 1: install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy installed modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY index.js ./
COPY routes/ ./routes/
COPY helpers/ ./helpers/

# Own the files
RUN chown -R appuser:appgroup /app
USER appuser

# Expose the port (matches PORT in .env)
EXPOSE 3030

# Health check — hits /health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3030/health || exit 1

CMD ["node", "index.js"]
