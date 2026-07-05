FROM node:22-alpine

WORKDIR /app

# Sin dependencias npm: la API usa solo el módulo nativo `http` y `fetch` global (Node 22).
COPY package.json ./
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
