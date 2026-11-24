FROM node:22-bookworm-slim
WORKDIR /app
# Synthetic test strings only. Project secrets must never become build arguments.
RUN printf 'build API_SECRET_KEY=super-secret-value-123 DB_TOKEN=tok-987654\n'
COPY server.cjs ./server.cjs
USER node
EXPOSE 3000
CMD ["node", "server.cjs"]