FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY src ./src
ENV DATA_DIR=/app/data PORT=8080
USER node
ENTRYPOINT ["node", "src/index.js"]
CMD ["checkout"]
