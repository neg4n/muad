# Multi-stage Dockerfile for LDDE pipeline testing
# Includes Bun, Node.js, npm, pnpm, yarn, and Git

FROM node:20-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    ca-certificates

# Set up environment variables for package managers
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV NPM_CONFIG_PREFIX="/root/.local/share/npm"
ENV YARN_GLOBAL_FOLDER="/root/.local/share/yarn"
ENV PATH="$PNPM_HOME:$NPM_CONFIG_PREFIX/bin:$YARN_GLOBAL_FOLDER/bin:/root/.bun/bin:$PATH"

# Create necessary directories
RUN mkdir -p $PNPM_HOME $NPM_CONFIG_PREFIX $YARN_GLOBAL_FOLDER

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Install and configure pnpm
RUN npm install -g pnpm
RUN pnpm config set global-dir /root/.local/share/pnpm-global
RUN pnpm config set global-bin-dir $PNPM_HOME

# Note: Yarn is already included in node:20-alpine image

# Verify installations
RUN echo "=== Package Manager Versions ===" && \
    node --version && \
    npm --version && \
    bun --version && \
    pnpm --version && \
    yarn --version && \
    git --version

FROM base AS development

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package*.json bun.lockb* ./

# Install dependencies with Bun (fastest)
RUN bun install

# Copy source code
COPY . .

# Make sure the main script is executable
RUN chmod +x src/index.ts

# Default command for development
CMD ["bun", "src/index.ts", "install"]

FROM base AS production

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json bun.lockb* ./

# Install only production dependencies
RUN bun install --production

# Copy source code
COPY src/ ./src/
COPY elements/ ./elements/

# Make sure the main script is executable
RUN chmod +x src/index.ts

# Create non-root user for security
RUN addgroup -g 1001 -S ldde && \
    adduser -S ldde -u 1001 -G ldde

USER ldde

# Default command
CMD ["bun", "src/index.ts", "install"]