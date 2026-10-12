FROM node:20 AS builder
ENV NODE_ENV=build

USER node
WORKDIR /home/node

COPY --chown=node:node . .
RUN npm ci
RUN npm run build
# a build without the pages must fail here, not start a server that serves nothing
RUN test -f backend/dist/app.js && test -f backend/dist/frontend/index.html
# the cat detector's model (backend/src/core/catDetector.ts): YOLOX-S, Apache-2.0, checked by its hash
RUN mkdir -p models \
    && curl -fsSL -o models/yolox_s.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx \
    && echo "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063  models/yolox_s.onnx" | sha256sum -c -

# -----

FROM node:20-slim

# deploy/deploy.sh removes the old images of this label after a build
LABEL org.kibbl.app=kibbl
ENV NODE_ENV=production

# heating cost reports are scans: pdftoppm draws their pages, Tesseract reads them (backend/src/heat/ocr.ts)
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-deu \
    && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /home/node

COPY --from=builder --chown=node:node /home/node/backend/dist/ ./
COPY --from=builder --chown=node:node /home/node/models/ ./models/
# native modules are kept out of the bundle (backend/tsup.config.ts)
RUN npm i --no-save --no-package-lock sharp@0.33 bufferutil@4 onnxruntime-node@1.30.0

EXPOSE 8790
CMD ["node", "app"]
