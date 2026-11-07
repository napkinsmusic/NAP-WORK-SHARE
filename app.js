import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { boardId, firebaseConfig } from "./firebase-config.js";

const status = document.getElementById("save-status");
const today = document.getElementById("today");
const dailyText = document.getElementById("daily-text");
const timers = new Map();
const bindings = new Map();
let writeRemote = null;
let saveSharedImage = null;
let deleteSharedImage = null;
const RICH_PREFIX = "<!--nap-rich-->";
const imageCache = new Map();
let selectedInlineImage = null;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const expiringFieldIds = new Set([
  "daily",
  "memo-0-content",
  "memo-1-content",
  "memo-2-content",
  "memo-3-content"
]);

function setStatus(message, type = "") {
  status.textContent = message;
  status.className = `save-status ${type}`.trim();
}

function updateToday() {
  const now = new Date();
  today.dateTime = new Intl.DateTimeFormat("sv-SE").format(now);
  today.textContent = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(now);
}

function readJson(key, fallback = {}) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") || fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function scheduleSave(fieldId, value) {
  setStatus(writeRemote ? "공유 저장 중..." : "이 기기에 저장됨");
  clearTimeout(timers.get(fieldId));
  timers.set(fieldId, setTimeout(async () => {
    if (!writeRemote) return;
    try {
      await writeRemote(fieldId, value);
      setStatus("실시간 공유됨", "connected");
    } catch (error) {
      console.error(error);
      setStatus("공유 저장 실패", "error");
    }
  }, 400));
}

function registerBinding(fieldId, options) {
  bindings.set(fieldId, options);
}

function renderPhoto(picker, preview, value) {
  if (!picker || !preview) return;
  preview.src = value || "";
  picker.classList.toggle("has-photo", Boolean(value));
}

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const size = 160;
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        canvas.width = size;
        canvas.height = size;
        canvas.getContext("2d").drawImage(
          image,
          (size - width) / 2,
          (size - height) / 2,
          width,
          height
        );
        resolve(canvas.toDataURL("image/jpeg", .82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function sanitizeRichHtml(html) {
  const source = document.createElement("div");
  const output = document.createElement("div");
  source.innerHTML = html;

  function copyNode(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.textContent));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;

    if (tag === "BR") {
      parent.append(document.createElement("br"));
      return;
    }

    if (tag === "IMG") {
      const imageId = node.dataset.imageId || "";
      if (!/^[a-zA-Z0-9-]{10,80}$/.test(imageId)) return;
      const image = document.createElement("img");
      image.dataset.imageId = imageId;
      const width = Number(node.dataset.width);
      if (Number.isFinite(width) && width >= 10 && width <= 100) {
        image.dataset.width = String(width);
        image.style.width = `${width}%`;
      }
      image.draggable = false;
      image.alt = "붙여넣은 이미지";
      image.title = "클릭 후 우측 아래를 드래그해 크기 조절";
      parent.append(image);
      return;
    }

    const container = tag === "DIV" ? document.createElement("div") : parent;
    for (const child of node.childNodes) copyNode(child, container);
    if (container !== parent) parent.append(container);
  }

  for (const child of source.childNodes) copyNode(child, output);
  return output.innerHTML;
}

function getEditorValue(editor) {
  return RICH_PREFIX + sanitizeRichHtml(editor.innerHTML);
}

function setEditorValue(editor, value) {
  if (value.startsWith(RICH_PREFIX)) {
    editor.innerHTML = sanitizeRichHtml(value.slice(RICH_PREFIX.length));
  } else {
    editor.textContent = value;
  }
  hydrateEditorImages(editor);
}

function hydrateEditorImages(root = document) {
  root.querySelectorAll("img[data-image-id]").forEach((image) => {
    const dataUrl = imageCache.get(image.dataset.imageId);
    if (dataUrl) image.src = dataUrl;
  });
}

function getImageIds(editor) {
  return new Set(
    [...editor.querySelectorAll("img[data-image-id]")]
      .map((image) => image.dataset.imageId)
  );
}

function clearSelectedImage() {
  selectedInlineImage?.classList.remove("selected");
  selectedInlineImage = null;
}

function selectInlineImage(image) {
  if (selectedInlineImage === image) return;
  selectedInlineImage?.classList.remove("selected");
  selectedInlineImage = image;
  image.classList.add("selected");
}

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("img[data-image-id]")) return;
  clearSelectedImage();
});

const MAX_IMAGE_DATA_URL = 420000;

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth) resolve(image);
      else reject(new Error("이미지를 읽지 못했습니다"));
    };
    image.onerror = () => reject(new Error("이미지를 읽지 못했습니다"));
    image.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("이미지 변환 실패"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function isWebpBlob(header) {
  return header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
    && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
}

async function canvasToImageDataUrl(canvas, mimeType, quality) {
  try {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    if (dataUrl.startsWith(`data:${mimeType};base64,`)) return dataUrl;
  } catch {
    // 일부 모바일 브라우저는 toDataURL에서 요청한 형식을 거절한다.
  }

  const blob = await new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), mimeType, quality);
  });
  if (!blob) return "";
  if (mimeType === "image/webp") {
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (!isWebpBlob(header)) return "";
  }
  const typed = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
  const dataUrl = await blobToDataUrl(typed);
  return String(dataUrl).startsWith(`data:${mimeType};base64,`) ? String(dataUrl) : "";
}

async function canvasToStoredDataUrl(canvas, quality) {
  return await canvasToImageDataUrl(canvas, "image/webp", quality)
    || canvasToImageDataUrl(canvas, "image/jpeg", quality);
}

async function renderImageCanvas(source, maxEdge) {
  if (source instanceof Blob && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(source);
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return canvas;
    } catch {
      // HEIC 등 createImageBitmap이 거절하면 Image 디코더로 다시 시도한다.
    }
  }

  let objectUrl = "";
  const imageUrl = source instanceof Blob ? (objectUrl = URL.createObjectURL(source)) : source;
  try {
    const image = await loadImageElement(imageUrl);
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function compressToWebpDataUrl(source) {
  const longestBudget = window.matchMedia("(max-width: 900px)").matches ? 1280 : 1600;
  let canvas = await renderImageCanvas(source, longestBudget);
  let quality = .86;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const dataUrl = await canvasToStoredDataUrl(canvas, quality);
    if (!dataUrl) throw new Error("이미지 변환 실패");
    if (dataUrl.length < MAX_IMAGE_DATA_URL) return dataUrl;
    if (quality > .46) {
      quality = Math.round((quality - .12) * 100) / 100;
      continue;
    }

    const next = document.createElement("canvas");
    next.width = Math.max(240, Math.round(canvas.width * .72));
    next.height = Math.max(1, Math.round(canvas.height * (next.width / canvas.width)));
    const context = next.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, next.width, next.height);
    context.drawImage(canvas, 0, 0, next.width, next.height);
    canvas = next;
    quality = .7;
  }

  throw new Error("이미지가 너무 큽니다");
}

function insertNodeAtRange(editor, range, node) {
  editor.focus();
  const target = range && editor.contains(range.commonAncestorContainer)
    ? range
    : document.createRange();

  if (!range || !editor.contains(range.commonAncestorContainer)) {
    target.selectNodeContents(editor);
    target.collapse(false);
  }

  target.deleteContents();
  const lastInserted = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ? node.lastChild
    : node;
  target.insertNode(node);
  if (lastInserted) target.setStartAfter(lastInserted);
  target.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(target);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function isImageFile(file) {
  if (!file) return false;
  const type = file.type || "";
  if (type.startsWith("image/")) return true;
  const name = file.name || "";
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(name)) return true;
  if (type === "application/octet-stream") return true;
  return !type && !name;
}

function clipboardMayContainImage(clipboard, html) {
  if (/<img\b/i.test(html || "")) return true;
  const types = [...(clipboard?.types || [])];
  return types.some((type) => type === "Files" || type.startsWith("image/"));
}

function snapshotClipboardImages(clipboard) {
  if (!clipboard) return [];
  const files = [];
  const seen = new Set();

  function push(file) {
    if (!file || !isImageFile(file)) return;
    const key = `${file.type}|${file.size}|${file.lastModified}|${file.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  }

  const listedFiles = clipboard.files?.length ? clipboard.files : null;
  if (listedFiles) {
    for (let index = 0; index < listedFiles.length; index += 1) push(listedFiles[index]);
  } else if (clipboard.items) {
    for (let index = 0; index < clipboard.items.length; index += 1) {
      const item = clipboard.items[index];
      const type = item.type || "";
      if (item.kind !== "file" && !type.startsWith("image/")) continue;
      push(item.getAsFile?.());
    }
  }

  if (files.length) {
    const pending = files.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      const type = file.type?.startsWith("image/") ? file.type : "";
      reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다"));
      reader.onload = () => {
        if (!reader.result?.byteLength) {
          resolve(null);
          return;
        }
        resolve(new Blob([reader.result], type ? { type } : undefined));
      };
      reader.readAsArrayBuffer(file);
    }));
    pending.reliable = files.some((file) => file.size > 0);
    return pending;
  }

  const dataUrl = readClipboardDataUrl(clipboard);
  if (!dataUrl) return [];
  const pending = [Promise.resolve(dataUrl)];
  pending.reliable = true;
  return pending;
}

function readClipboardText(clipboard, type) {
  if (!clipboard) return "";
  try {
    return clipboard.getData(type) || "";
  } catch {
    return "";
  }
}

function readClipboardDataUrl(clipboard) {
  const html = readClipboardText(clipboard, "text/html");
  const match = html.match(/src=["'](data:image\/[\s\S]+?)["']/i);
  return (match?.[1] || "").replace(/\s/g, "");
}

function editorFromSelection() {
  const active = document.activeElement?.closest?.(".memo-content");
  if (active) return active;
  const node = window.getSelection()?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.(".memo-content") || null;
}

function editorForPasteEvent(event) {
  const target = event.target?.nodeType === Node.ELEMENT_NODE
    ? event.target
    : event.target?.parentElement;
  return target?.closest?.(".memo-content") || editorFromSelection();
}

function currentEditorRange(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return range.cloneRange();
}

function waitForImage(image) {
  if (image.naturalWidth) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(fail, 8000);
    const poll = setInterval(() => {
      if (image.naturalWidth) finish();
    }, 40);

    function finish() {
      if (settled || !image.naturalWidth) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    }

    function fail() {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      reject(new Error("이미지를 읽지 못했습니다"));
    }

    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", fail, { once: true });
    image.decode?.().then(finish).catch(() => {});
  });
}

async function blobFromDisplayedImage(image) {
  await waitForImage(image);
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .92));
  if (!blob) throw new Error("이미지를 읽지 못했습니다");
  return blob;
}

function pixelsFromImage(image) {
  const src = image.currentSrc || image.src || "";
  if (!src) return Promise.reject(new Error("이미지를 읽지 못했습니다"));
  return blobFromDisplayedImage(image).catch((error) => {
    if (src.startsWith("data:")) return src;
    throw error;
  });
}

async function insertInlineImage(editor, range, source) {
  if (!saveSharedImage) {
    setStatus("이미지 공유 연결 중...", "error");
    return false;
  }

  try {
    setStatus("이미지 업로드 중...");
    const dataUrl = await compressToWebpDataUrl(source);
    const imageId = await saveSharedImage(dataUrl);
    const fragment = document.createDocumentFragment();
    const image = document.createElement("img");
    image.src = dataUrl;
    image.dataset.imageId = imageId;
    image.draggable = false;
    image.alt = "붙여넣은 이미지";
    image.title = "눌러서 크기 조절";
    fragment.append(image, document.createElement("br"));
    insertNodeAtRange(editor, range, fragment);
    setStatus("이미지 공유됨", "connected");
    return true;
  } catch (error) {
    console.error(error);
    setStatus("이미지 업로드 실패", "error");
    return false;
  }
}

function insertPlainText(editor, text) {
  const selection = window.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r/g, "").split("\n");

  lines.forEach((line, index) => {
    if (index) fragment.append(document.createElement("br"));
    fragment.append(document.createTextNode(line));
  });

  insertNodeAtRange(editor, range, fragment);
}

updateToday();
setInterval(updateToday, 60000);

dailyText.value = localStorage.getItem("daily-text") || "";
registerBinding("daily", {
  get: () => dailyText.value,
  set: (value) => {
    if (document.activeElement !== dailyText) dailyText.value = value;
    localStorage.setItem("daily-text", value);
  }
});

dailyText.addEventListener("input", () => {
  localStorage.setItem("daily-text", dailyText.value);
  scheduleSave("daily", dailyText.value);
});

document.querySelectorAll(".memo").forEach((memo) => {
  const index = memo.dataset.memo;
  const localKey = `simple-memo-${index}`;
  const title = memo.querySelector(".memo-title");
  const content = memo.querySelector(".memo-content");
  const photoInput = memo.querySelector(".photo-input");
  const photoPicker = memo.querySelector(".photo-picker");
  const photoPreview = memo.querySelector(".photo-preview");
  const previousMemo = index === "0" ? readJson("simple-memo") : {};
  const saved = readJson(localKey, previousMemo);

  title.value = saved.title || "";
  if (saved.contentHtml) {
    setEditorValue(content, saved.contentHtml);
  } else {
    content.textContent = saved.content || "";
  }
  let knownImageIds = getImageIds(content);
  let resizeState = null;

  function saveLocalMemo() {
    localStorage.setItem(localKey, JSON.stringify({
      title: title.value,
      contentHtml: getEditorValue(content)
    }));
  }

  registerBinding(`memo-${index}-title`, {
    get: () => title.value,
    set: (value) => {
      if (document.activeElement !== title) title.value = value;
      saveLocalMemo();
    }
  });

  registerBinding(`memo-${index}-content`, {
    get: () => getEditorValue(content),
    set: (value) => {
      if (document.activeElement !== content) {
        setEditorValue(content, value);
        knownImageIds = getImageIds(content);
      }
      saveLocalMemo();
    }
  });

  title.addEventListener("input", () => {
    saveLocalMemo();
    scheduleSave(`memo-${index}-title`, title.value);
  });

  let adoptingImages = false;
  let handlingPaste = false;
  let lastImagePaste = 0;
  let ignoreNativeUntil = 0;

  function editorRange() {
    return currentEditorRange(content) || (() => {
      const fallback = document.createRange();
      fallback.selectNodeContents(content);
      fallback.collapse(false);
      return fallback;
    })();
  }

  async function consumeClipboardImages(range, pending) {
    handlingPaste = true;
    let uploaded = false;

    try {
      const sources = (await Promise.all(pending)).filter(Boolean);
      for (const source of sources) {
        uploaded = await insertInlineImage(content, range, source) || uploaded;
      }
    } catch (error) {
      console.error(error);
      setStatus("이미지 업로드 실패", "error");
    } finally {
      handlingPaste = false;
    }

    if (!uploaded) {
      adoptNativeImages();
      return;
    }

    ignoreNativeUntil = Date.now() + 1200;
    content.querySelectorAll("img:not([data-image-id])").forEach((image) => image.remove());
    content.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function adoptNativeImages() {
    if (adoptingImages || handlingPaste || Date.now() < ignoreNativeUntil) return;
    const images = [...content.querySelectorAll("img:not([data-image-id]):not(.uploading)")];
    const jobs = [];

    for (const image of images) {
      const src = image.currentSrc || image.src || "";
      if (!src) continue;
      image.classList.add("uploading");
      jobs.push({ image, pending: pixelsFromImage(image) });
    }

    if (!jobs.length) return;
    adoptingImages = true;

    if (!saveSharedImage) {
      for (const job of jobs) job.image.remove();
      adoptingImages = false;
      setStatus("이미지 공유 연결 중...", "error");
      content.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    setStatus("이미지 업로드 중...");
    let failed = false;

    for (const job of jobs) {
      try {
        const dataUrl = await compressToWebpDataUrl(await job.pending);
        const imageId = await saveSharedImage(dataUrl);
        job.image.src = dataUrl;
        job.image.dataset.imageId = imageId;
        job.image.draggable = false;
        job.image.alt = "붙여넣은 이미지";
        job.image.title = "눌러서 크기 조절";
        job.image.classList.remove("uploading");
      } catch (error) {
        console.error(error);
        job.image.remove();
        failed = true;
      }
    }

    adoptingImages = false;
    content.dispatchEvent(new Event("input", { bubbles: true }));
    if (failed) setStatus("이미지 업로드 실패", "error");
    if (content.querySelector("img:not([data-image-id]):not(.uploading)")) adoptNativeImages();
  }

  const imageObserver = new MutationObserver(() => {
    if (handlingPaste) return;
    if (Date.now() < ignoreNativeUntil) {
      content.querySelectorAll("img:not([data-image-id])").forEach((image) => image.remove());
      return;
    }
    if (content.querySelector("img:not([data-image-id]):not(.uploading)")) adoptNativeImages();
  });
  imageObserver.observe(content, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"]
  });

  content.addEventListener("input", () => {
    if (
      !handlingPaste
      && Date.now() >= ignoreNativeUntil
      && content.querySelector("img:not([data-image-id]):not(.uploading)")
    ) {
      adoptNativeImages();
    }
    if (adoptingImages || content.querySelector("img:not([data-image-id])")) return;

    const currentImageIds = getImageIds(content);
    for (const imageId of knownImageIds) {
      if (!currentImageIds.has(imageId)) deleteSharedImage?.(imageId);
    }
    knownImageIds = currentImageIds;
    saveLocalMemo();
    scheduleSave(`memo-${index}-content`, getEditorValue(content));
  });

  content.addEventListener("pointerdown", (event) => {
    if (!event.target.matches("img[data-image-id]")) return;
    const image = event.target;
    selectInlineImage(image);
    const rect = image.getBoundingClientRect();
    const isResizeCorner = rect.right - event.clientX <= 28
      && rect.bottom - event.clientY <= 28;
    if (!isResizeCorner) return;

    event.preventDefault();
    image.classList.add("selected", "resizing");
    image.setPointerCapture(event.pointerId);
    resizeState = {
      image,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: rect.width
    };
  });

  content.addEventListener("pointermove", (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const maxWidth = content.clientWidth;
    const width = Math.min(
      maxWidth,
      Math.max(80, resizeState.startWidth + event.clientX - resizeState.startX)
    );
    const percent = Math.round((width / maxWidth) * 1000) / 10;
    resizeState.image.dataset.width = String(percent);
    resizeState.image.style.width = `${percent}%`;
  });

  function finishResize(event) {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    resizeState.image.classList.remove("resizing");
    resizeState.image.releasePointerCapture?.(event.pointerId);
    resizeState = null;
    content.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus("이미지 크기 저장됨", "connected");
  }

  content.addEventListener("pointerup", finishResize);
  content.addEventListener("pointercancel", finishResize);

  content.addEventListener("dblclick", (event) => {
    if (!event.target.matches("img[data-image-id]")) return;
    event.target.removeAttribute("data-width");
    event.target.style.removeProperty("width");
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });

  content.addEventListener("keydown", (event) => {
    const selectedImage = content.querySelector("img.selected");
    if (!selectedImage || !["Backspace", "Delete"].includes(event.key)) return;
    event.preventDefault();
    selectedImage.remove();
    if (selectedInlineImage === selectedImage) clearSelectedImage();
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });

  function scheduleAdopt() {
    [40, 180, 700].forEach((delay) => {
      setTimeout(() => {
        if (handlingPaste || Date.now() < ignoreNativeUntil) return;
        adoptNativeImages();
      }, delay);
    });
  }

  function onBeforeInput(event) {
    if (event.inputType !== "insertFromPaste") return;
    if (editorForPasteEvent(event) !== content) return;
    if (performance.now() - lastImagePaste < 700) {
      event.preventDefault();
      return;
    }

    const pending = snapshotClipboardImages(event.dataTransfer);
    if (!pending.reliable) return;
    lastImagePaste = performance.now();
    event.preventDefault();
    consumeClipboardImages(editorRange(), pending);
  }

  function onPaste(event) {
    if (editorForPasteEvent(event) !== content) return;
    if (performance.now() - lastImagePaste < 700) {
      event.preventDefault();
      return;
    }

    const clipboard = event.clipboardData;
    const pending = snapshotClipboardImages(clipboard);
    const text = readClipboardText(clipboard, "text/plain");
    const html = readClipboardText(clipboard, "text/html");
    const imageHint = clipboardMayContainImage(clipboard, html) || pending.length > 0;

    if (pending.reliable) {
      lastImagePaste = performance.now();
      event.preventDefault();
      consumeClipboardImages(editorRange(), pending);
      return;
    }

    if (imageHint) {
      lastImagePaste = performance.now();
      if (pending.length) consumeClipboardImages(editorRange(), pending);
      scheduleAdopt();
      return;
    }

    if (text) {
      event.preventDefault();
      insertPlainText(content, text);
    }
  }

  content.addEventListener("beforeinput", onBeforeInput);
  content.addEventListener("paste", onPaste);
  document.addEventListener("beforeinput", (event) => {
    if (event.target?.closest?.(".memo-content")) return;
    onBeforeInput(event);
  });
  document.addEventListener("paste", (event) => {
    if (event.target?.closest?.(".memo-content")) return;
    onPaste(event);
  });

  if (!photoInput) return;

  const photoKey = `simple-memo-photo-${index}`;
  const savedPhoto = localStorage.getItem(photoKey) || "";
  renderPhoto(photoPicker, photoPreview, savedPhoto);

  registerBinding(`memo-${index}-photo`, {
    get: () => localStorage.getItem(photoKey) || "",
    set: (value) => {
      localStorage.setItem(photoKey, value);
      renderPhoto(photoPicker, photoPreview, value);
    }
  });

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    if (!file) return;

    try {
      setStatus("사진 처리 중...");
      const photo = await compressPhoto(file);
      localStorage.setItem(photoKey, photo);
      renderPhoto(photoPicker, photoPreview, photo);
      scheduleSave(`memo-${index}-photo`, photo);
    } catch (error) {
      console.error(error);
      setStatus("사진 처리 실패", "error");
    } finally {
      photoInput.value = "";
    }
  });
});

async function connectFirebase() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("REPLACE_")) {
    setStatus("Firebase 설정 필요", "error");
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const credential = await signInAnonymously(auth);
    const imagesRef = collection(db, "boards", boardId, "images");

    saveSharedImage = async (dataUrl) => {
      const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await setDoc(doc(imagesRef, id), {
        dataUrl,
        createdAt: serverTimestamp(),
        createdBy: credential.user.uid
      });
      imageCache.set(id, dataUrl);
      return id;
    };

    deleteSharedImage = async (imageId) => {
      imageCache.delete(imageId);
      try {
        await deleteDoc(doc(imagesRef, imageId));
      } catch (error) {
        console.error(error);
        setStatus("이미지 삭제 실패", "error");
      }
    };

    onSnapshot(imagesRef, (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === "removed") {
          imageCache.delete(change.doc.id);
          if (selectedInlineImage?.dataset.imageId === change.doc.id) clearSelectedImage();
          document.querySelectorAll(`img[data-image-id="${change.doc.id}"]`)
            .forEach((image) => image.remove());
        } else {
          const imageData = change.doc.data();
          const createdAt = imageData.createdAt?.toMillis?.();
          if (createdAt && Date.now() - createdAt >= RETENTION_MS) {
            deleteSharedImage(change.doc.id);
            continue;
          }
          imageCache.set(change.doc.id, String(imageData.dataUrl || ""));
        }
      }
      hydrateEditorImages();
    }, (error) => {
      console.error(error);
      setStatus("공유 이미지 연결 오류", "error");
    });

    writeRemote = (fieldId, value) => setDoc(
      doc(db, "boards", boardId, "fields", fieldId),
      {
        value,
        updatedAt: serverTimestamp(),
        updatedBy: credential.user.uid
      }
    );

    for (const [fieldId, binding] of bindings) {
      const fieldRef = doc(db, "boards", boardId, "fields", fieldId);
      let initialized = false;

      onSnapshot(fieldRef, async (snapshot) => {
        if (snapshot.exists()) {
          initialized = true;
          const fieldData = snapshot.data();
          const updatedAt = fieldData.updatedAt?.toMillis?.();
          if (
            expiringFieldIds.has(fieldId)
            && updatedAt
            && Date.now() - updatedAt >= RETENTION_MS
          ) {
            binding.set("");
            try {
              await deleteDoc(fieldRef);
            } catch (error) {
              if (!["permission-denied", "not-found"].includes(error.code)) throw error;
            }
            return;
          }
          binding.set(String(fieldData.value ?? ""));
        } else if (!initialized) {
          initialized = true;
          await writeRemote(fieldId, binding.get());
        } else {
          binding.set("");
        }
      }, (error) => {
        console.error(error);
        setStatus("실시간 연결 오류", "error");
      });
    }

    setStatus("실시간 공유 연결됨", "connected");
  } catch (error) {
    console.error(error);
    setStatus("Firebase 연결 실패", "error");
  }
}

connectFirebase();
