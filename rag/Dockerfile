# ─── Builder Stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package descriptors and install all dependencies (including dev for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy full source and configuration
COPY . .

# Build the TypeScript project to dist/
RUN npm run build

# ─── Production Stage ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package descriptors and install ONLY production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled /dist folder from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001

# The default command is to run the API, but docker-compose overrides this for the worker
CMD ["npm", "run", "start"]
