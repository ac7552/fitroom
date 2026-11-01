# Fitroom's vision service (vision.mjs): Node with the same model library the page uses, on the CPU.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY vision.mjs ./
ENV PORT=8787 MODELS_DIR=/models
VOLUME ["/models"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://localhost:8787/up').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "vision.mjs"]
