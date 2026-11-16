FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs ./
COPY public ./public
EXPOSE 5677
USER node
CMD ["node", "server.mjs"]
