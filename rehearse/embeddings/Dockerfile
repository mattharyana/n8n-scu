FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV MODEL_CACHE_DIR=/models
ENV PORT=8000
EXPOSE 8000
CMD ["node", "server.mjs"]
