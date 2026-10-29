FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV DESENE_CLOUD=1 HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node","server.js"]
