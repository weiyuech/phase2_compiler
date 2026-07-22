const DEFAULTS = {
  threshold: 0.3,
  boxThreshold: 0.5,
  minArea: 20,
  minWidth: 4,
  minHeight: 2,
  maxBoxes: 50
};

export function extractTextLineBoxes(outputTensor, imageInfo, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const { data, dims } = outputTensor;

  if (!Array.isArray(dims) || dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) {
    throw new Error(`Unsupported OCR detector output dims: ${JSON.stringify(dims)}`);
  }

  const detHeight = dims[2];
  const detWidth = dims[3];
  const components = connectedComponents(data, detWidth, detHeight, cfg);
  const rows = mergeComponentsIntoRows(components, detHeight);
  const boxes = rows.map((row) => toOriginalRect(row, imageInfo, detWidth, detHeight));

  return boxes
    .filter((box) => box.width >= 2 && box.height >= 2)
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .slice(0, cfg.maxBoxes);
}

function connectedComponents(data, width, height, cfg) {
  const visited = new Uint8Array(width * height);
  const boxes = [];

  for (let i = 0; i < data.length; i++) {
    if (visited[i] || data[i] <= cfg.threshold) continue;

    const stack = [i];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    let scoreSum = 0;
    visited[i] = 1;

    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = Math.floor(p / width);

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      area += 1;
      scoreSum += data[p];

      pushNeighbor(stack, visited, data, width, height, p, x - 1, y, cfg.threshold);
      pushNeighbor(stack, visited, data, width, height, p, x + 1, y, cfg.threshold);
      pushNeighbor(stack, visited, data, width, height, p, x, y - 1, cfg.threshold);
      pushNeighbor(stack, visited, data, width, height, p, x, y + 1, cfg.threshold);
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const score = scoreSum / area;

    if (
      area >= cfg.minArea &&
      boxWidth >= cfg.minWidth &&
      boxHeight >= cfg.minHeight &&
      score >= cfg.boxThreshold
    ) {
      boxes.push({ minX, minY, maxX, maxY, area, score });
    }
  }

  return boxes;
}

function pushNeighbor(stack, visited, data, width, height, _p, x, y, threshold) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const idx = y * width + x;
  if (visited[idx] || data[idx] <= threshold) return;
  visited[idx] = 1;
  stack.push(idx);
}

function mergeComponentsIntoRows(components, detHeight) {
  const sorted = components.slice().sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
  const rows = [];
  const rowTolerance = Math.max(6, Math.round(detHeight * 0.03));

  for (const box of sorted) {
    const centerY = (box.minY + box.maxY) / 2;
    const row = rows.find((candidate) => Math.abs(centerY - candidate.centerY) <= rowTolerance);

    if (!row) {
      rows.push({
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
        centerY,
        count: 1
      });
      continue;
    }

    row.minX = Math.min(row.minX, box.minX);
    row.minY = Math.min(row.minY, box.minY);
    row.maxX = Math.max(row.maxX, box.maxX);
    row.maxY = Math.max(row.maxY, box.maxY);
    row.centerY = ((row.centerY * row.count) + centerY) / (row.count + 1);
    row.count += 1;
  }

  return rows;
}

function toOriginalRect(row, imageInfo, detWidth, detHeight) {
  const scaleX = imageInfo.originalWidth / detWidth;
  const scaleY = imageInfo.originalHeight / detHeight;
  const rowHeight = Math.max(1, (row.maxY - row.minY + 1) * scaleY);
  const padX = Math.round(rowHeight * 0.1);
  const padY = Math.round(rowHeight * 0.1);

  const left = clamp(Math.floor(row.minX * scaleX - padX), 0, imageInfo.originalWidth - 1);
  const top = clamp(Math.floor(row.minY * scaleY - padY), 0, imageInfo.originalHeight - 1);
  const right = clamp(Math.ceil((row.maxX + 1) * scaleX + padX), left + 1, imageInfo.originalWidth);
  const bottom = clamp(Math.ceil((row.maxY + 1) * scaleY + padY), top + 1, imageInfo.originalHeight);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
