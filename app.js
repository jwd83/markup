const TOOL_WIDTHS = {
  pen: [2, 4, 6],
  highlight: [8, 16, 24],
  arrow: [2, 4, 8],
  eraser: [8, 16, 24],
};

const FONT_FAMILIES = [
  "Arial",
  "Verdana",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Segoe UI",
  "sans-serif",
  "serif",
  "monospace",
];

const FONT_SIZES = [14, 18, 24, 32, 40, 52];
const HIGHLIGHT_ALPHA = 0.32;
const MAX_HISTORY = 100;
const PAN_PADDING = 32;
const HANDLE_RADIUS = 8;
const MOVE_TOLERANCE = 6;

const elements = {
  shell: document.querySelector(".app-shell"),
  fileInput: document.querySelector("#fileInput"),
  openButton: document.querySelector("#openButton"),
  emptyOpenButton: document.querySelector("#emptyOpenButton"),
  copyButton: document.querySelector("#copyButton"),
  saveButton: document.querySelector("#saveButton"),
  exportFormat: document.querySelector("#exportFormat"),
  exportQuality: document.querySelector("#exportQuality"),
  qualityWrap: document.querySelector("#qualityWrap"),
  qualityValue: document.querySelector("#qualityValue"),
  undoButton: document.querySelector("#undoButton"),
  redoButton: document.querySelector("#redoButton"),
  fitButton: document.querySelector("#fitButton"),
  actualSizeButton: document.querySelector("#actualSizeButton"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomReadout: document.querySelector("#zoomReadout"),
  toolRow: document.querySelector("#toolRow"),
  colorPicker: document.querySelector("#colorPicker"),
  widthControls: document.querySelector("#widthControls"),
  fontFamilySelect: document.querySelector("#fontFamilySelect"),
  fontSizeSelect: document.querySelector("#fontSizeSelect"),
  boldToggle: document.querySelector("#boldToggle"),
  italicToggle: document.querySelector("#italicToggle"),
  viewport: document.querySelector("#viewport"),
  stage: document.querySelector("#stage"),
  canvas: document.querySelector("#displayCanvas"),
  textEditor: document.querySelector("#textEditor"),
  layerList: document.querySelector("#layerList"),
  emptyState: document.querySelector("#emptyState"),
  dropTarget: document.querySelector("#dropTarget"),
  dragOverlay: document.querySelector("#dragOverlay"),
  toast: document.querySelector("#toast"),
};

const displayContext = elements.canvas.getContext("2d");

const state = {
  activeTool: "select",
  color: "#ff4f3f",
  widths: {
    pen: 4,
    highlight: 16,
    arrow: 4,
    eraser: 16,
  },
  textDefaults: {
    fontFamily: "Arial",
    fontSize: 24,
    bold: false,
    italic: false,
  },
  doc: null,
  history: {
    done: [],
    undone: [],
    cleanIndex: 0,
  },
  selection: {
    objectId: null,
  },
  interaction: null,
  zoom: 1,
  panX: PAN_PADDING,
  panY: PAN_PADDING,
  dragDepth: 0,
  isSpacePressed: false,
  textEditorState: null,
  toastTimer: null,
  pendingRender: false,
};

function createObjectId(prefix = "obj") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function deepClone(value) {
  return structuredClone(value);
}

function createLayerCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return {
    canvas,
    context: canvas.getContext("2d"),
    dirty: true,
  };
}

async function loadImageFromSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load that image."));
    image.src = source;
  });
}

function createDocumentSnapshot() {
  if (!state.doc) {
    return null;
  }

  return {
    width: state.doc.width,
    height: state.doc.height,
    baseImageSrc: state.doc.baseImageSrc,
    visibility: deepClone(state.doc.visibility),
    penOps: deepClone(state.doc.penOps),
    highlightOps: deepClone(state.doc.highlightOps),
    objects: deepClone(state.doc.objects),
  };
}

async function restoreSnapshot(snapshot) {
  cancelTextEditing({ discard: true });
  clearSelection();

  if (!snapshot) {
    state.doc = null;
    state.zoom = 1;
    state.panX = PAN_PADDING;
    state.panY = PAN_PADDING;
    render();
    syncUi();
    return;
  }

  const image = await loadImageFromSource(snapshot.baseImageSrc);
  state.doc = {
    width: snapshot.width,
    height: snapshot.height,
    baseImageSrc: snapshot.baseImageSrc,
    baseImage: image,
    visibility: deepClone(snapshot.visibility),
    penOps: deepClone(snapshot.penOps),
    highlightOps: deepClone(snapshot.highlightOps),
    objects: deepClone(snapshot.objects),
    penLayer: createLayerCanvas(snapshot.width, snapshot.height),
    highlightLayer: createLayerCanvas(snapshot.width, snapshot.height),
  };

  state.doc.penLayer.dirty = true;
  state.doc.highlightLayer.dirty = true;
  fitToViewport();
  syncUi();
  render();
}

function markClean() {
  state.history.cleanIndex = state.history.done.length;
  syncUi();
}

function isDirty() {
  return state.history.done.length !== state.history.cleanIndex;
}

function updateLayerRender(layerName) {
  if (!state.doc) {
    return;
  }

  const layer = layerName === "pen" ? state.doc.penLayer : state.doc.highlightLayer;
  const operations = layerName === "pen" ? state.doc.penOps : state.doc.highlightOps;
  const context = layer.context;

  context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);

  for (const operation of operations) {
    context.save();
    if (operation.mode === "erase") {
      context.globalCompositeOperation = "destination-out";
      context.strokeStyle = "rgba(0, 0, 0, 1)";
    } else {
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = operation.color;
      context.globalAlpha = operation.alpha ?? 1;
    }
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = operation.width;
    context.beginPath();
    const [firstPoint, ...rest] = operation.points;
    context.moveTo(firstPoint.x, firstPoint.y);
    for (const point of rest) {
      context.lineTo(point.x, point.y);
    }
    if (operation.points.length === 1) {
      context.lineTo(firstPoint.x + 0.01, firstPoint.y + 0.01);
    }
    context.stroke();
    context.restore();
  }

  layer.dirty = false;
}

function ensureLayerRender() {
  if (!state.doc) {
    return;
  }

  if (state.doc.penLayer.dirty) {
    updateLayerRender("pen");
  }
  if (state.doc.highlightLayer.dirty) {
    updateLayerRender("highlight");
  }
}

function getObjectById(id) {
  if (!state.doc || !id) {
    return null;
  }
  return state.doc.objects.find((object) => object.id === id) ?? null;
}

function getSelectedObject() {
  return getObjectById(state.selection.objectId);
}

function clearSelection() {
  state.selection.objectId = null;
  render();
  syncUi();
}

function setSelection(objectId) {
  state.selection.objectId = objectId;
  render();
  syncUi();
}

function getTextFont(object, scale = 1) {
  const weight = object.bold ? "700" : "400";
  const style = object.italic ? "italic" : "normal";
  return `${style} ${weight} ${object.fontSize * scale}px ${object.fontFamily}`;
}

function measureTextLayout(object) {
  const scratch = document.createElement("canvas").getContext("2d");
  scratch.font = getTextFont(object);
  const lines = (object.text || "").split("\n");
  const lineHeight = object.fontSize * 1.3;
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, scratch.measureText(line || " ").width);
  }
  return {
    lines,
    lineHeight,
    width,
    height: Math.max(lineHeight, lines.length * lineHeight),
  };
}

function drawArrow(context, object, options = {}) {
  const { highlightSelection = false } = options;
  const { start, end, color, width } = object;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(12, width * 4);
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - headLength * Math.cos(angle - Math.PI / 7),
    end.y - headLength * Math.sin(angle - Math.PI / 7)
  );
  context.lineTo(
    end.x - headLength * Math.cos(angle + Math.PI / 7),
    end.y - headLength * Math.sin(angle + Math.PI / 7)
  );
  context.closePath();
  context.fill();

  if (highlightSelection) {
    drawArrowHandles(context, object);
  }

  context.restore();
}

function drawArrowHandles(context, object) {
  context.save();
  context.strokeStyle = "#ffffff";
  context.fillStyle = "#0f7ef3";
  context.lineWidth = 2;
  for (const point of [object.start, object.end]) {
    context.beginPath();
    context.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function drawText(context, object, options = {}) {
  const { highlightSelection = false } = options;
  const layout = measureTextLayout(object);
  context.save();
  context.font = getTextFont(object);
  context.fillStyle = object.color;
  context.textBaseline = "top";
  layout.lines.forEach((line, index) => {
    context.fillText(line, object.x, object.y + index * layout.lineHeight);
  });

  if (highlightSelection) {
    context.strokeStyle = "#0f7ef3";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.strokeRect(
      object.x - 4,
      object.y - 4,
      layout.width + 8,
      layout.height + 8
    );
    context.setLineDash([]);
  }

  context.restore();
}

function compositeTo(context, options = {}) {
  const { includeSelection = true } = options;
  if (!state.doc) {
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    return;
  }

  ensureLayerRender();
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);

  if (state.doc.visibility.image) {
    context.drawImage(state.doc.baseImage, 0, 0);
  }
  if (state.doc.visibility.pen) {
    context.drawImage(state.doc.penLayer.canvas, 0, 0);
  }
  if (state.doc.visibility.highlight) {
    context.drawImage(state.doc.highlightLayer.canvas, 0, 0);
  }

  for (const object of state.doc.objects) {
    if (!object.visible) {
      continue;
    }
    if (object.type === "arrow") {
      drawArrow(context, object, {
        highlightSelection: includeSelection && state.selection.objectId === object.id,
      });
    } else if (
      object.type === "text" &&
      (!state.textEditorState || state.textEditorState.objectId !== object.id)
    ) {
      drawText(context, object, {
        highlightSelection: includeSelection && state.selection.objectId === object.id,
      });
    }
  }
}

function clampPan() {
  if (!state.doc) {
    return;
  }

  const viewportRect = elements.viewport.getBoundingClientRect();
  const scaledWidth = state.doc.width * state.zoom;
  const scaledHeight = state.doc.height * state.zoom;

  if (scaledWidth + PAN_PADDING * 2 < viewportRect.width) {
    state.panX = (viewportRect.width - scaledWidth) / 2;
  }

  if (scaledHeight + PAN_PADDING * 2 < viewportRect.height) {
    state.panY = (viewportRect.height - scaledHeight) / 2;
  }
}

function applyStageTransform() {
  elements.stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}

function render() {
  if (state.pendingRender) {
    return;
  }
  state.pendingRender = true;
  requestAnimationFrame(() => {
    state.pendingRender = false;
    if (!state.doc) {
      elements.canvas.width = 1;
      elements.canvas.height = 1;
      displayContext.clearRect(0, 0, 1, 1);
      applyStageTransform();
      return;
    }

    elements.canvas.width = state.doc.width;
    elements.canvas.height = state.doc.height;
    compositeTo(displayContext, { includeSelection: true });
    drawInteractionOverlay(displayContext);
    positionTextEditor();
    clampPan();
    applyStageTransform();
  });
}

function fitToViewport() {
  if (!state.doc) {
    return;
  }
  const rect = elements.viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const zoom = Math.min(
    (rect.width - PAN_PADDING * 2) / state.doc.width,
    (rect.height - PAN_PADDING * 2) / state.doc.height
  );
  state.zoom = Math.max(0.1, zoom);
  state.panX = (rect.width - state.doc.width * state.zoom) / 2;
  state.panY = (rect.height - state.doc.height * state.zoom) / 2;
  render();
  syncUi();
}

function setZoom(nextZoom, anchor = null) {
  if (!state.doc) {
    return;
  }

  const rect = elements.viewport.getBoundingClientRect();
  const clampedZoom = Math.min(8, Math.max(0.1, nextZoom));
  const focusPoint = anchor ?? { x: rect.width / 2, y: rect.height / 2 };
  const docX = (focusPoint.x - state.panX) / state.zoom;
  const docY = (focusPoint.y - state.panY) / state.zoom;

  state.zoom = clampedZoom;
  state.panX = focusPoint.x - docX * state.zoom;
  state.panY = focusPoint.y - docY * state.zoom;
  render();
  syncUi();
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("is-hidden");
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.add("is-hidden");
  }, 2200);
}

function syncWidthControls() {
  const selected = getSelectedObject();
  let mode = state.activeTool;
  let activeWidth = null;

  if (mode === "select" && selected?.type === "arrow") {
    mode = "arrow";
    activeWidth = selected.width;
  } else if (mode === "select" && (!selected || selected.type === "text")) {
    mode = null;
  } else {
    activeWidth = state.widths[mode] ?? null;
  }

  elements.widthControls.innerHTML = "";
  if (!mode || !TOOL_WIDTHS[mode]) {
    return;
  }

  for (const width of TOOL_WIDTHS[mode]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button width-chip${width === activeWidth ? " is-active" : ""}`;
    button.textContent = `${width}px`;
    button.disabled = !state.doc;
    button.addEventListener("click", () => {
      if (state.activeTool === "select" && selected?.type === "arrow") {
        const next = { ...selected, width };
        recordAction({
          type: "updateObject",
          objectId: selected.id,
          before: deepClone(selected),
          after: next,
        });
      } else {
        state.widths[mode] = width;
        syncUi();
      }
    });
    elements.widthControls.append(button);
  }
}

function syncTextControls() {
  const selected = getSelectedObject();
  const activeTextTarget = state.textEditorState
    ? state.textEditorState.style
    : selected?.type === "text" && state.activeTool === "select"
      ? selected
      : state.textDefaults;

  const disabled = !state.doc;
  elements.fontFamilySelect.disabled = disabled;
  elements.fontSizeSelect.disabled = disabled;
  elements.boldToggle.disabled = disabled;
  elements.italicToggle.disabled = disabled;
  elements.colorPicker.disabled = disabled;

  elements.fontFamilySelect.value = activeTextTarget.fontFamily;
  elements.fontSizeSelect.value = String(activeTextTarget.fontSize);
  elements.boldToggle.classList.toggle("is-active", Boolean(activeTextTarget.bold));
  elements.italicToggle.classList.toggle("is-active", Boolean(activeTextTarget.italic));

  if (state.textEditorState) {
    elements.colorPicker.value = state.textEditorState.style.color;
  } else if (selected?.type === "text" && state.activeTool === "select") {
    elements.colorPicker.value = selected.color;
  } else if (selected?.type === "arrow" && state.activeTool === "select") {
    elements.colorPicker.value = selected.color;
  } else {
    elements.colorPicker.value = state.color;
  }
}

function syncUi() {
  const hasDocument = Boolean(state.doc);
  elements.shell.dataset.hasDocument = String(hasDocument);
  elements.emptyState.classList.toggle("is-hidden", hasDocument);
  elements.viewport.classList.toggle("is-disabled", !hasDocument);
  elements.copyButton.disabled = !hasDocument;
  elements.saveButton.disabled = !hasDocument;
  elements.exportFormat.disabled = !hasDocument;
  elements.undoButton.disabled = !hasDocument || state.history.done.length === 0;
  elements.redoButton.disabled = !hasDocument || state.history.undone.length === 0;
  elements.fitButton.disabled = !hasDocument;
  elements.actualSizeButton.disabled = !hasDocument;
  elements.zoomOutButton.disabled = !hasDocument;
  elements.zoomInButton.disabled = !hasDocument;

  for (const button of elements.toolRow.querySelectorAll("[data-tool]")) {
    button.disabled = !hasDocument;
    button.classList.toggle("is-active", button.dataset.tool === state.activeTool);
  }

  elements.zoomReadout.textContent = hasDocument ? `${Math.round(state.zoom * 100)}%` : "--";
  const needsQuality = hasDocument && elements.exportFormat.value !== "png";
  elements.qualityWrap.classList.toggle("is-hidden", !needsQuality);
  elements.qualityValue.textContent = `${Math.round(Number(elements.exportQuality.value) * 100)}%`;

  syncWidthControls();
  syncTextControls();
  renderLayerList();

  document.title = hasDocument && isDirty() ? "Clipboard Markup *" : "Clipboard Markup";
}

function getLayerRows() {
  if (!state.doc) {
    return [];
  }

  const rows = [
    { id: "image", kind: "fixed", label: "Image", meta: "Base image", visible: state.doc.visibility.image },
    { id: "pen", kind: "fixed", label: "Pen", meta: "Grouped brush layer", visible: state.doc.visibility.pen },
    {
      id: "highlight",
      kind: "fixed",
      label: "Highlight",
      meta: "Grouped highlighter layer",
      visible: state.doc.visibility.highlight,
    },
  ];

  const objectRows = [...state.doc.objects]
    .reverse()
    .map((object) => ({
      id: object.id,
      kind: "object",
      label: object.type === "arrow" ? "Arrow" : previewTextLabel(object.text),
      meta: object.type === "arrow" ? `${object.width}px` : `${object.fontSize}px ${object.fontFamily}`,
      visible: object.visible,
      objectType: object.type,
    }));

  return rows.concat(objectRows);
}

function previewTextLabel(value) {
  const normalized = (value || "Text").replace(/\s+/g, " ").trim();
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized || "Text";
}

function renderLayerList() {
  elements.layerList.innerHTML = "";
  if (!state.doc) {
    const empty = document.createElement("div");
    empty.className = "layer-empty";
    empty.textContent = "Load an image to start stacking annotations.";
    elements.layerList.append(empty);
    return;
  }

  for (const row of getLayerRows()) {
    const item = document.createElement("div");
    item.className = `layer-item${row.kind === "fixed" ? " is-fixed" : ""}${
      state.selection.objectId === row.id ? " is-selected" : ""
    }`;
    item.dataset.layerId = row.id;
    item.dataset.kind = row.kind;
    if (row.kind === "object") {
      item.draggable = true;
    }

    const dragHandle = document.createElement("div");
    dragHandle.className = "drag-handle";
    dragHandle.textContent = row.kind === "object" ? "⋮⋮" : "•";

    const text = document.createElement("div");
    text.className = "layer-text";
    const name = document.createElement("div");
    name.className = "layer-name";
    name.textContent = row.label;
    const meta = document.createElement("div");
    meta.className = "layer-meta";
    meta.textContent = row.meta;
    text.append(name, meta);

    const visibilityButton = document.createElement("button");
    visibilityButton.type = "button";
    visibilityButton.className = "button";
    visibilityButton.textContent = row.visible ? "Hide" : "Show";
    visibilityButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleLayerVisibility(row);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button";
    deleteButton.textContent = row.kind === "object" ? "Del" : "—";
    deleteButton.disabled = row.kind !== "object";
    if (row.kind === "object") {
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSelectedObject(row.id);
      });
    }

    item.append(dragHandle, text, visibilityButton, deleteButton);
    item.addEventListener("click", () => {
      if (row.kind === "object") {
        setSelection(row.id);
        state.activeTool = "select";
        syncUi();
      }
    });
    attachLayerDragHandlers(item, row);
    elements.layerList.append(item);
  }
}

function attachLayerDragHandlers(item, row) {
  if (row.kind !== "object") {
    return;
  }

  item.addEventListener("dragstart", (event) => {
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.id);
  });

  item.addEventListener("dragend", () => {
    item.classList.remove("is-dragging");
  });

  item.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });

  item.addEventListener("drop", (event) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === row.id) {
      return;
    }
    reorderObjectById(sourceId, row.id);
  });
}

function toggleLayerVisibility(row) {
  if (!state.doc) {
    return;
  }

  if (row.kind === "fixed") {
    recordAction({
      type: "setFixedVisibility",
      layerKey: row.id,
      before: state.doc.visibility[row.id],
      after: !state.doc.visibility[row.id],
    });
    return;
  }

  const object = getObjectById(row.id);
  if (!object) {
    return;
  }
  recordAction({
    type: "updateObject",
    objectId: object.id,
    before: deepClone(object),
    after: { ...object, visible: !object.visible },
  });
}

function reorderObjectById(sourceId, targetId) {
  const sourceIndex = state.doc.objects.findIndex((item) => item.id === sourceId);
  const targetIndex = state.doc.objects.findIndex((item) => item.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return;
  }

  recordAction({
    type: "reorderObject",
    objectId: sourceId,
    fromIndex: sourceIndex,
    toIndex: targetIndex,
  });
}

function applyObjectOrder(objectId, fromIndex, toIndex) {
  const index = state.doc.objects.findIndex((item) => item.id === objectId);
  if (index === -1) {
    return;
  }
  const [object] = state.doc.objects.splice(index, 1);
  state.doc.objects.splice(toIndex, 0, object);
}

async function applyAction(action, direction = "forward") {
  switch (action.type) {
    case "replaceDocument": {
      const snapshot = direction === "forward" ? action.after : action.before;
      await restoreSnapshot(snapshot);
      break;
    }
    case "rasterOperation": {
      const layerName = action.layer;
      const collection = layerName === "pen" ? state.doc.penOps : state.doc.highlightOps;
      if (direction === "forward") {
        collection.push(deepClone(action.operation));
      } else {
        const index = collection.findIndex((operation) => operation.id === action.operation.id);
        if (index !== -1) {
          collection.splice(index, 1);
        }
      }
      state.doc[layerName === "pen" ? "penLayer" : "highlightLayer"].dirty = true;
      render();
      break;
    }
    case "rasterOperationPair": {
      for (const entry of direction === "forward" ? action.operations : [...action.operations].reverse()) {
        await applyAction(
          { type: "rasterOperation", layer: entry.layer, operation: entry.operation },
          direction
        );
      }
      break;
    }
    case "addObject": {
      if (direction === "forward") {
        state.doc.objects.push(deepClone(action.object));
        setSelection(action.object.id);
      } else {
        const index = state.doc.objects.findIndex((object) => object.id === action.object.id);
        if (index !== -1) {
          state.doc.objects.splice(index, 1);
        }
        if (state.selection.objectId === action.object.id) {
          clearSelection();
        }
      }
      render();
      break;
    }
    case "updateObject": {
      const next = direction === "forward" ? action.after : action.before;
      const index = state.doc.objects.findIndex((object) => object.id === action.objectId);
      if (index !== -1) {
        state.doc.objects[index] = deepClone(next);
      }
      render();
      break;
    }
    case "deleteObject": {
      if (direction === "forward") {
        const index = state.doc.objects.findIndex((object) => object.id === action.object.id);
        if (index !== -1) {
          state.doc.objects.splice(index, 1);
        }
        if (state.selection.objectId === action.object.id) {
          clearSelection();
        }
      } else {
        state.doc.objects.splice(action.index, 0, deepClone(action.object));
      }
      render();
      break;
    }
    case "reorderObject": {
      if (direction === "forward") {
        applyObjectOrder(action.objectId, action.fromIndex, action.toIndex);
      } else {
        applyObjectOrder(action.objectId, action.toIndex, action.fromIndex);
      }
      render();
      break;
    }
    case "setFixedVisibility": {
      state.doc.visibility[action.layerKey] = direction === "forward" ? action.after : action.before;
      if (action.layerKey !== "image") {
        state.doc[action.layerKey === "pen" ? "penLayer" : "highlightLayer"].dirty = true;
      }
      if (state.selection.objectId && !getSelectedObject()?.visible) {
        clearSelection();
      }
      render();
      break;
    }
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

async function recordAction(action, options = {}) {
  await applyAction(action, "forward");
  pushHistory(action);
}

function pushHistory(action) {
  state.history.done.push(action);
  state.history.undone = [];
  if (state.history.done.length > MAX_HISTORY) {
    state.history.done.shift();
    state.history.cleanIndex = Math.max(0, state.history.cleanIndex - 1);
  }
  syncUi();
}

async function undo() {
  if (!state.history.done.length) {
    return;
  }
  cancelTextEditing({ commit: true });
  const action = state.history.done.pop();
  state.history.undone.push(action);
  await applyAction(action, "reverse");
  syncUi();
}

async function redo() {
  if (!state.history.undone.length) {
    return;
  }
  cancelTextEditing({ commit: true });
  const action = state.history.undone.pop();
  state.history.done.push(action);
  await applyAction(action, "forward");
  syncUi();
}

function normalizePoint(event) {
  const rect = elements.viewport.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.panX) / state.zoom,
    y: (event.clientY - rect.top - state.panY) / state.zoom,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point, start, end) {
  const lengthSquared =
    (end.x - start.x) * (end.x - start.x) + (end.y - start.y) * (end.y - start.y);
  if (lengthSquared === 0) {
    return distance(point, start);
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) /
        lengthSquared
    )
  );
  return distance(point, {
    x: start.x + t * (end.x - start.x),
    y: start.y + t * (end.y - start.y),
  });
}

function pointInRect(point, rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function getTextBounds(object) {
  const layout = measureTextLayout(object);
  return {
    x: object.x - 4,
    y: object.y - 4,
    width: layout.width + 8,
    height: layout.height + 8,
  };
}

function hitTestObject(point) {
  if (!state.doc) {
    return null;
  }

  const selected = getSelectedObject();
  if (selected?.type === "arrow" && selected.visible) {
    if (distance(point, selected.start) <= HANDLE_RADIUS + 2) {
      return { object: selected, mode: "arrow-start" };
    }
    if (distance(point, selected.end) <= HANDLE_RADIUS + 2) {
      return { object: selected, mode: "arrow-end" };
    }
  }

  for (let index = state.doc.objects.length - 1; index >= 0; index -= 1) {
    const object = state.doc.objects[index];
    if (!object.visible) {
      continue;
    }

    if (object.type === "text") {
      if (pointInRect(point, getTextBounds(object))) {
        return { object, mode: "move" };
      }
      continue;
    }

    if (distanceToSegment(point, object.start, object.end) <= object.width + MOVE_TOLERANCE) {
      return { object, mode: "move" };
    }
  }

  return null;
}

function beginStroke(point, tool) {
  state.interaction = {
    type: tool === "eraser" ? "erase" : "draw",
    tool,
    points: [point],
  };
}

function extendStroke(point) {
  if (!state.interaction || !["draw", "erase"].includes(state.interaction.type)) {
    return;
  }
  state.interaction.points.push(point);
  render();
}

function finishStroke() {
  const interaction = state.interaction;
  state.interaction = null;
  render();

  if (!interaction || interaction.points.length === 0) {
    return;
  }

  if (interaction.type === "draw") {
    const operation = {
      id: createObjectId("stroke"),
      mode: "draw",
      color: state.color,
      width: state.widths[interaction.tool],
      alpha: interaction.tool === "highlight" ? HIGHLIGHT_ALPHA : 1,
      points: interaction.points,
    };
    recordAction({
      type: "rasterOperation",
      layer: interaction.tool === "highlight" ? "highlight" : "pen",
      operation,
    });
    return;
  }

  if (interaction.type === "erase") {
    const sharedOperation = {
      mode: "erase",
      width: state.widths.eraser,
      points: interaction.points,
    };
    recordAction({
      type: "rasterOperationPair",
      operations: [
        {
          layer: "pen",
          operation: { ...sharedOperation, id: createObjectId("erase-pen") },
        },
        {
          layer: "highlight",
          operation: { ...sharedOperation, id: createObjectId("erase-highlight") },
        },
      ],
    });
  }
}

function startArrow(point) {
  state.interaction = {
    type: "arrow-create",
    object: {
      id: createObjectId("arrow"),
      type: "arrow",
      visible: true,
      color: state.color,
      width: state.widths.arrow,
      start: point,
      end: point,
    },
  };
  render();
}

function updateArrow(point) {
  if (!state.interaction) {
    return;
  }
  state.interaction.object.end = point;
  render();
}

function finishArrow() {
  const interaction = state.interaction;
  state.interaction = null;
  render();
  if (!interaction) {
    return;
  }
  if (distance(interaction.object.start, interaction.object.end) < 2) {
    return;
  }
  recordAction({
    type: "addObject",
    object: interaction.object,
  });
}

function startMove(point, hit) {
  setSelection(hit.object.id);
  state.interaction = {
    type: hit.mode,
    objectId: hit.object.id,
    startPoint: point,
    originalObject: deepClone(hit.object),
  };
}

function updateMove(point) {
  if (!state.interaction) {
    return;
  }
  const object = getObjectById(state.interaction.objectId);
  if (!object) {
    return;
  }
  const deltaX = point.x - state.interaction.startPoint.x;
  const deltaY = point.y - state.interaction.startPoint.y;
  const next = deepClone(state.interaction.originalObject);

  if (state.interaction.type === "move") {
    if (next.type === "text") {
      next.x += deltaX;
      next.y += deltaY;
    } else {
      next.start.x += deltaX;
      next.start.y += deltaY;
      next.end.x += deltaX;
      next.end.y += deltaY;
    }
  }
  if (state.interaction.type === "arrow-start") {
    next.start = point;
  }
  if (state.interaction.type === "arrow-end") {
    next.end = point;
  }
  const index = state.doc.objects.findIndex((item) => item.id === object.id);
  state.doc.objects[index] = next;
  render();
}

function finishMove() {
  const interaction = state.interaction;
  state.interaction = null;
  if (!interaction) {
    return;
  }
  const current = getObjectById(interaction.objectId);
  if (!current) {
    return;
  }
  const before = interaction.originalObject;
  const after = deepClone(current);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    render();
    return;
  }

  pushHistory({
    type: "updateObject",
    objectId: current.id,
    before,
    after,
  });
}

function beginPan(event) {
  state.interaction = {
    type: "pan",
    startClientX: event.clientX,
    startClientY: event.clientY,
    originPanX: state.panX,
    originPanY: state.panY,
  };
}

function updatePan(event) {
  if (!state.interaction || state.interaction.type !== "pan") {
    return;
  }
  state.panX = state.interaction.originPanX + (event.clientX - state.interaction.startClientX);
  state.panY = state.interaction.originPanY + (event.clientY - state.interaction.startClientY);
  render();
}

function finishPan() {
  state.interaction = null;
}

function beginTextEdit(config) {
  if (!state.doc) {
    return;
  }
  const sourceObject = config.object ?? null;
  const style = {
    color: sourceObject?.color ?? state.color,
    fontFamily: sourceObject?.fontFamily ?? state.textDefaults.fontFamily,
    fontSize: sourceObject?.fontSize ?? state.textDefaults.fontSize,
    bold: sourceObject?.bold ?? state.textDefaults.bold,
    italic: sourceObject?.italic ?? state.textDefaults.italic,
  };
  state.textEditorState = {
    objectId: sourceObject?.id ?? null,
    x: config.x,
    y: config.y,
    initialObject: sourceObject ? deepClone(sourceObject) : null,
    style,
    returnTool: sourceObject ? "select" : "text",
  };
  state.activeTool = "text";
  if (sourceObject) {
    setSelection(sourceObject.id);
  }
  elements.textEditor.classList.remove("is-hidden");
  elements.textEditor.value = sourceObject?.text ?? "";
  elements.textEditor.style.left = `${config.x}px`;
  elements.textEditor.style.top = `${config.y}px`;
  elements.textEditor.style.color = style.color;
  elements.textEditor.style.fontFamily = style.fontFamily;
  elements.textEditor.style.fontSize = `${style.fontSize}px`;
  elements.textEditor.style.fontWeight = style.bold ? "700" : "400";
  elements.textEditor.style.fontStyle = style.italic ? "italic" : "normal";
  resizeTextEditor();
  elements.textEditor.focus();
  elements.textEditor.select();
  render();
  syncUi();
}

function positionTextEditor() {
  if (!state.textEditorState) {
    elements.textEditor.classList.add("is-hidden");
    return;
  }
  elements.textEditor.style.left = `${state.textEditorState.x}px`;
  elements.textEditor.style.top = `${state.textEditorState.y}px`;
}

function resizeTextEditor() {
  if (!state.textEditorState) {
    return;
  }
  elements.textEditor.style.height = "auto";
  const lines = (elements.textEditor.value || " ").split("\n");
  const scratch = document.createElement("canvas").getContext("2d");
  scratch.font = getTextFont({
    fontFamily: elements.textEditor.style.fontFamily,
    fontSize: Number.parseFloat(elements.textEditor.style.fontSize),
    bold: elements.textEditor.style.fontWeight === "700",
    italic: elements.textEditor.style.fontStyle === "italic",
  });
  let width = 120;
  for (const line of lines) {
    width = Math.max(width, scratch.measureText(line || " ").width + 24);
  }
  elements.textEditor.style.width = `${width}px`;
  elements.textEditor.style.height = `${Math.max(40, elements.textEditor.scrollHeight)}px`;
}

function cancelTextEditing(options = {}) {
  const { commit = false, discard = false } = options;
  if (!state.textEditorState) {
    return;
  }

  if (commit && !discard) {
    commitTextEdit();
    return;
  }

  state.activeTool = state.textEditorState.returnTool;
  state.textEditorState = null;
  elements.textEditor.classList.add("is-hidden");
  elements.textEditor.value = "";
  render();
  syncUi();
}

function commitTextEdit() {
  if (!state.textEditorState) {
    return;
  }

  const content = elements.textEditor.value.replace(/\r/g, "");
  const baseObject = state.textEditorState.initialObject;
  const style = state.textEditorState.style;
  const nextObject = {
    id: baseObject?.id ?? createObjectId("text"),
    type: "text",
    visible: true,
    x: state.textEditorState.x,
    y: state.textEditorState.y,
    text: content,
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    bold: style.bold,
    italic: style.italic,
    visible: baseObject?.visible ?? true,
  }

  if (!content.trim()) {
    state.activeTool = state.textEditorState.returnTool;
    if (baseObject) {
      const index = state.doc.objects.findIndex((object) => object.id === baseObject.id);
      recordAction({
        type: "deleteObject",
        object: baseObject,
        index,
      });
    }
    state.textEditorState = null;
    elements.textEditor.classList.add("is-hidden");
    render();
    syncUi();
    return;
  }

  state.activeTool = state.textEditorState.returnTool;
  state.textEditorState = null;
  elements.textEditor.classList.add("is-hidden");

  if (baseObject) {
    recordAction({
      type: "updateObject",
      objectId: baseObject.id,
      before: baseObject,
      after: nextObject,
    });
  } else {
    recordAction({
      type: "addObject",
      object: nextObject,
    });
  }
}

function updateSelectedOrDefaultText(setting, value) {
  if (state.textEditorState) {
    state.textEditorState.style[setting] = value;
    if (setting === "fontFamily") {
      elements.textEditor.style.fontFamily = value;
    }
    if (setting === "fontSize") {
      elements.textEditor.style.fontSize = `${value}px`;
    }
    if (setting === "bold") {
      elements.textEditor.style.fontWeight = value ? "700" : "400";
    }
    if (setting === "italic") {
      elements.textEditor.style.fontStyle = value ? "italic" : "normal";
    }
    resizeTextEditor();
    syncUi();
    return;
  }

  const selected = getSelectedObject();
  if (selected?.type === "text" && state.activeTool === "select") {
    const next = { ...selected, [setting]: value };
    recordAction({
      type: "updateObject",
      objectId: selected.id,
      before: deepClone(selected),
      after: next,
    });
  } else {
    state.textDefaults[setting] = value;
    syncUi();
  }
}

function updateSelectedOrDefaultColor(value) {
  if (state.textEditorState) {
    state.textEditorState.style.color = value;
    state.color = value;
    elements.textEditor.style.color = value;
    syncUi();
    return;
  }

  const selected = getSelectedObject();
  if (
    state.activeTool === "select" &&
    selected &&
    (selected.type === "arrow" || selected.type === "text")
  ) {
    const next = { ...selected, color: value };
    recordAction({
      type: "updateObject",
      objectId: selected.id,
      before: deepClone(selected),
      after: next,
    });
  } else {
    state.color = value;
    if (state.textEditorState) {
      elements.textEditor.style.color = value;
    }
    syncUi();
  }
}

async function replaceDocumentWithSource(source) {
  const image = await loadImageFromSource(source);
  const nextSnapshot = {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    baseImageSrc: source,
    visibility: {
      image: true,
      pen: true,
      highlight: true,
    },
    penOps: [],
    highlightOps: [],
    objects: [],
  };

  const before = createDocumentSnapshot();
  await recordAction({
    type: "replaceDocument",
    before,
    after: nextSnapshot,
  });
  markClean();
  state.activeTool = "select";
  clearSelection();
  showToast("Image loaded.");
}

function confirmDocumentReplacement() {
  if (!state.doc || !isDirty()) {
    return true;
  }
  return window.confirm("Replace the current image and discard unsaved edits?");
}

function handleFiles(files) {
  const file = [...files].find((candidate) => candidate.type.startsWith("image/"));
  if (!file) {
    showToast("That file is not an image.");
    return;
  }
  if (!confirmDocumentReplacement()) {
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await replaceDocumentWithSource(reader.result);
    } catch (error) {
      showToast(error.message);
    }
  };
  reader.readAsDataURL(file);
}

async function handlePasteEvent(event) {
  const items = [...event.clipboardData.items];
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) {
    return;
  }
  event.preventDefault();
  if (!confirmDocumentReplacement()) {
    return;
  }

  const file = imageItem.getAsFile();
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await replaceDocumentWithSource(reader.result);
    } catch (error) {
      showToast(error.message);
    }
  };
  reader.readAsDataURL(file);
}

async function exportBlob(format) {
  if (!state.doc) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = state.doc.width;
  canvas.height = state.doc.height;
  const context = canvas.getContext("2d");
  compositeTo(context, { includeSelection: false });

  const mimeType =
    format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const quality = format === "png" ? undefined : Number(elements.exportQuality.value);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function copyToClipboard() {
  if (!state.doc) {
    return;
  }
  try {
    const blob = await exportBlob("png");
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": blob,
      }),
    ]);
    showToast("Copied PNG to clipboard.");
  } catch (error) {
    showToast("Clipboard copy failed in this browser context.");
  }
}

async function saveExport() {
  if (!state.doc) {
    return;
  }
  const format = elements.exportFormat.value;
  const blob = await exportBlob(format);
  if (!blob) {
    showToast("Could not generate that export.");
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const extension = format === "jpeg" ? "jpg" : format;
  link.href = url;
  link.download = `markup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
  markClean();
  showToast(`Saved ${format.toUpperCase()}.`);
}

function deleteSelectedObject(objectId = state.selection.objectId) {
  const object = getObjectById(objectId);
  if (!object) {
    return;
  }
  const index = state.doc.objects.findIndex((item) => item.id === object.id);
  recordAction({
    type: "deleteObject",
    object,
    index,
  });
}

function handleCanvasPointerDown(event) {
  if (!state.doc) {
    return;
  }
  if (event.button === 1 || state.isSpacePressed) {
    beginPan(event);
    return;
  }

  if (event.button !== 0) {
    return;
  }

  if (state.textEditorState && event.target !== elements.textEditor) {
    commitTextEdit();
  }

  const point = normalizePoint(event);
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > state.doc.width ||
    point.y > state.doc.height
  ) {
    return;
  }

  if (state.activeTool === "select") {
    const hit = hitTestObject(point);
    if (!hit) {
      clearSelection();
      return;
    }
    if (hit.object.type === "text" && event.detail >= 2) {
      beginTextEdit({ x: hit.object.x, y: hit.object.y, object: hit.object });
      return;
    }
    startMove(point, hit);
    return;
  }

  if (state.activeTool === "pen" || state.activeTool === "highlight") {
    beginStroke(point, state.activeTool);
    return;
  }

  if (state.activeTool === "eraser") {
    beginStroke(point, "eraser");
    return;
  }

  if (state.activeTool === "arrow") {
    startArrow(point);
    return;
  }

  if (state.activeTool === "text") {
    beginTextEdit({ x: point.x, y: point.y });
  }
}

function handleCanvasPointerMove(event) {
  if (!state.interaction) {
    return;
  }
  const point = normalizePoint(event);
  if (state.interaction.type === "pan") {
    updatePan(event);
    return;
  }
  if (state.interaction.type === "draw" || state.interaction.type === "erase") {
    extendStroke(point);
    return;
  }
  if (state.interaction.type === "arrow-create") {
    updateArrow(point);
    return;
  }
  if (["move", "arrow-start", "arrow-end"].includes(state.interaction.type)) {
    updateMove(point);
  }
}

function handleCanvasPointerUp() {
  if (!state.interaction) {
    return;
  }
  const interactionType = state.interaction.type;
  if (interactionType === "pan") {
    finishPan();
    return;
  }
  if (interactionType === "draw" || interactionType === "erase") {
    finishStroke();
    return;
  }
  if (interactionType === "arrow-create") {
    finishArrow();
    return;
  }
  if (["move", "arrow-start", "arrow-end"].includes(interactionType)) {
    finishMove();
  }
}

function drawInteractionOverlay(context) {
  if (!state.doc || !state.interaction) {
    return;
  }
  if (state.interaction.type === "arrow-create") {
    drawArrow(context, state.interaction.object);
    return;
  }
  if (!["draw", "erase"].includes(state.interaction.type)) {
    return;
  }
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth =
    state.interaction.type === "erase" ? state.widths.eraser : state.widths[state.interaction.tool];
  context.strokeStyle = state.interaction.type === "erase" ? "rgba(12, 126, 243, 0.4)" : state.color;
  context.globalAlpha =
    state.interaction.type === "erase"
      ? 1
      : state.interaction.tool === "highlight"
        ? HIGHLIGHT_ALPHA
        : 1;
  context.beginPath();
  const [firstPoint, ...rest] = state.interaction.points;
  context.moveTo(firstPoint.x, firstPoint.y);
  for (const point of rest) {
    context.lineTo(point.x, point.y);
  }
  if (state.interaction.points.length === 1) {
    context.lineTo(firstPoint.x + 0.01, firstPoint.y + 0.01);
  }
  context.stroke();
  context.restore();
}

function installToolbarOptions() {
  FONT_FAMILIES.forEach((family) => {
    const option = document.createElement("option");
    option.value = family;
    option.textContent = family;
    elements.fontFamilySelect.append(option);
  });

  FONT_SIZES.forEach((size) => {
    const option = document.createElement("option");
    option.value = String(size);
    option.textContent = `${size}px`;
    elements.fontSizeSelect.append(option);
  });
}

function bindEvents() {
  elements.openButton.addEventListener("click", () => elements.fileInput.click());
  elements.emptyOpenButton.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", (event) => {
    if (event.target.files?.length) {
      handleFiles(event.target.files);
      elements.fileInput.value = "";
    }
  });
  elements.copyButton.addEventListener("click", copyToClipboard);
  elements.saveButton.addEventListener("click", saveExport);
  elements.undoButton.addEventListener("click", undo);
  elements.redoButton.addEventListener("click", redo);
  elements.fitButton.addEventListener("click", fitToViewport);
  elements.actualSizeButton.addEventListener("click", () => setZoom(1));
  elements.zoomOutButton.addEventListener("click", () => setZoom(state.zoom / 1.2));
  elements.zoomInButton.addEventListener("click", () => setZoom(state.zoom * 1.2));
  elements.exportFormat.addEventListener("change", syncUi);
  elements.exportQuality.addEventListener("input", syncUi);
  elements.colorPicker.addEventListener("input", (event) => {
    updateSelectedOrDefaultColor(event.target.value);
  });

  elements.fontFamilySelect.addEventListener("change", (event) => {
    updateSelectedOrDefaultText("fontFamily", event.target.value);
  });
  elements.fontSizeSelect.addEventListener("change", (event) => {
    updateSelectedOrDefaultText("fontSize", Number(event.target.value));
  });
  elements.boldToggle.addEventListener("click", () => {
    const activeValue = state.textEditorState
      ? state.textEditorState.style.bold
      : getSelectedObject()?.type === "text" && state.activeTool === "select"
        ? getSelectedObject().bold
        : state.textDefaults.bold;
    updateSelectedOrDefaultText("bold", !activeValue);
  });
  elements.italicToggle.addEventListener("click", () => {
    const activeValue = state.textEditorState
      ? state.textEditorState.style.italic
      : getSelectedObject()?.type === "text" && state.activeTool === "select"
        ? getSelectedObject().italic
        : state.textDefaults.italic;
    updateSelectedOrDefaultText("italic", !activeValue);
  });

  elements.toolRow.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tool]");
    if (!button || button.disabled) {
      return;
    }
    cancelTextEditing({ commit: true });
    state.activeTool = button.dataset.tool;
    syncUi();
  });

  elements.dropTarget.addEventListener("pointerdown", handleCanvasPointerDown);
  window.addEventListener("pointermove", handleCanvasPointerMove);
  window.addEventListener("pointerup", handleCanvasPointerUp);

  elements.dropTarget.addEventListener("dragenter", (event) => {
    event.preventDefault();
    state.dragDepth += 1;
    elements.dragOverlay.classList.remove("is-hidden");
  });
  elements.dropTarget.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  elements.dropTarget.addEventListener("dragleave", (event) => {
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      elements.dragOverlay.classList.add("is-hidden");
    }
  });
  elements.dropTarget.addEventListener("drop", (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    elements.dragOverlay.classList.add("is-hidden");
    if (event.dataTransfer?.files?.length) {
      handleFiles(event.dataTransfer.files);
    }
  });

  window.addEventListener("paste", handlePasteEvent);
  window.addEventListener("resize", () => {
    if (state.doc) {
      fitToViewport();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;

    if (event.code === "Space" && !event.repeat) {
      state.isSpacePressed = true;
      elements.dropTarget.style.cursor = "grab";
    }

    if (state.textEditorState) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelTextEditing({ discard: true });
      }
      if (meta && event.key.toLowerCase() === "enter") {
        event.preventDefault();
        commitTextEdit();
      }
      return;
    }

    if (meta && event.key.toLowerCase() === "z" && event.shiftKey) {
      event.preventDefault();
      redo();
      return;
    }
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && getSelectedObject()) {
      event.preventDefault();
      deleteSelectedObject();
      return;
    }
    if (event.key === "Escape") {
      clearSelection();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      state.isSpacePressed = false;
      elements.dropTarget.style.cursor = "";
    }
  });

  elements.textEditor.addEventListener("input", resizeTextEditor);
  elements.textEditor.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "enter") {
      event.preventDefault();
      commitTextEdit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelTextEditing({ discard: true });
    }
  });
  elements.textEditor.addEventListener("blur", (event) => {
    const nextFocus = event.relatedTarget;
    if (nextFocus?.closest(".topbar")) {
      return;
    }
    if (state.textEditorState) {
      commitTextEdit();
    }
  });
}

installToolbarOptions();
bindEvents();
syncUi();
