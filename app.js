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
const imageToolbar = document.getElementById("image-toolbar");
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

function hideImageToolbar() {
  selectedInlineImage?.classList.remove("selected");
  selectedInlineImage = null;
  imageToolbar.hidden = true;
}

function positionImageToolbar() {
  if (!selectedInlineImage?.isConnected) {
    hideImageToolbar();
    return;
  }

  imageToolbar.hidden = false;
  const imageRect = selectedInlineImage.getBoundingClientRect();
  const toolbarRect = imageToolbar.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - toolbarRect.width - 8,
    Math.max(8, imageRect.left)
  );
  const below = imageRect.bottom + 8;
  const top = below + toolbarRect.height <= window.innerHeight
    ? below
    : Math.max(8, imageRect.top - toolbarRect.height - 8);
  imageToolbar.style.left = `${left}px`;
  imageToolbar.style.top = `${top}px`;
}

function selectInlineImage(image) {
  if (selectedInlineImage !== image) {
    selectedInlineImage?.classList.remove("selected");
    selectedInlineImage = image;
    image.classList.add("selected");
  }
  positionImageToolbar();
}

imageToolbar.addEventListener("pointerdown", (event) => event.stopPropagation());
imageToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-image-action]");
  if (!button || !selectedInlineImage?.isConnected) return;
  const editor = selectedInlineImage.closest(".memo-content");
  const action = button.dataset.imageAction;

  if (action === "delete") {
    selectedInlineImage.remove();
    hideImageToolbar();
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const currentWidth = Number(selectedInlineImage.dataset.width)
    || (selectedInlineImage.getBoundingClientRect().width / editor.clientWidth) * 100;
  const width = Math.min(100, Math.max(10, currentWidth + (action === "larger" ? 10 : -10)));
  selectedInlineImage.dataset.width = String(Math.round(width * 10) / 10);
  selectedInlineImage.style.width = `${width}%`;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  requestAnimationFrame(positionImageToolbar);
  setStatus("이미지 크기 저장됨", "connected");
});

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".image-toolbar, img[data-image-id]")) return;
  hideImageToolbar();
});

window.addEventListener("resize", positionImageToolbar);
window.addEventListener("scroll", positionImageToolbar, true);

function compressInlineImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const maxBytes = 300 * 1024;
        const maxSize = 1600;
        let scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        let quality = .86;

        const canvasToBlob = (canvas, type, blobQuality) => new Promise((resolveBlob) => {
          canvas.toBlob((blob) => {
            if (blob || type === "image/jpeg") {
              resolveBlob(blob);
              return;
            }
            canvas.toBlob(resolveBlob, "image/jpeg", blobQuality);
          }, type, blobQuality);
        });

        const convert = async () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          const blob = await canvasToBlob(canvas, "image/webp", quality);
          if (!blob) {
            reject(new Error("이미지 변환 실패"));
            return;
          }
          if (blob.size <= maxBytes || scale < .2) {
            resolve(blob);
            return;
          }
          if (quality > .5) {
            quality -= .1;
          } else {
            scale *= .82;
            quality = .72;
          }
          convert();
        };

        convert().catch(reject);
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
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
  if (!file.type || file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(file.name || "");
}

function readClipboardImage(clipboard) {
  if (!clipboard) return null;

  if (clipboard.files) {
    for (let index = 0; index < clipboard.files.length; index += 1) {
      if (isImageFile(clipboard.files[index])) return clipboard.files[index];
    }
  }

  if (!clipboard.items) return null;
  for (let index = 0; index < clipboard.items.length; index += 1) {
    const item = clipboard.items[index];
    const type = item.type || "";
    if (item.kind !== "file" && !type.startsWith("image/")) continue;
    const file = item.getAsFile?.();
    if (isImageFile(file)) return file;
  }
  return null;
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
  const match = html.match(/src=["'](data:image\/[^"']+)["']/i);
  return match?.[1] || "";
}

function currentEditorRange(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return range.cloneRange();
}

async function sourceToBlob(source) {
  if (source instanceof Blob) return source;
  const response = await fetch(source);
  if (!response.ok) throw new Error("이미지 변환 실패");
  return response.blob();
}

function waitForImage(image) {
  if (image.complete) {
    return image.naturalWidth
      ? Promise.resolve()
      : Promise.reject(new Error("이미지를 읽지 못했습니다"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("이미지를 읽지 못했습니다")), 4000);
    image.addEventListener("load", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    image.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("이미지를 읽지 못했습니다"));
    }, { once: true });
  });
}

async function blobFromImageElement(image) {
  const src = image.currentSrc || image.src || "";
  if (!src || src.startsWith("webkit-fake-url:") || src.startsWith("file:")) {
    throw new Error("이미지를 읽지 못했습니다");
  }
  if (src.startsWith("data:") || src.startsWith("blob:")) return sourceToBlob(src);

  try {
    return await sourceToBlob(src);
  } catch {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .86));
    if (!blob) throw new Error("이미지를 읽지 못했습니다");
    return blob;
  }
}

async function insertInlineImage(editor, range, source) {
  if (!saveSharedImage) {
    setStatus("이미지 공유 연결 중...", "error");
    return;
  }

  try {
    setStatus("이미지 업로드 중...");
    const compressed = await compressInlineImage(await sourceToBlob(source));
    const dataUrl = await blobToDataUrl(compressed);
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
  } catch (error) {
    console.error(error);
    setStatus("이미지 업로드 실패", "error");
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

  async function adoptNativeImages() {
    if (adoptingImages) return;
    const images = [...content.querySelectorAll("img:not([data-image-id]):not(.uploading)")];
    if (!images.length) return;

    adoptingImages = true;
    for (const image of images) image.classList.add("uploading");

    if (!saveSharedImage) {
      for (const image of images) image.remove();
      adoptingImages = false;
      setStatus("이미지 공유 연결 중...", "error");
      content.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    setStatus("이미지 업로드 중...");
    for (const image of images) {
      try {
        await waitForImage(image);
        const compressed = await compressInlineImage(await blobFromImageElement(image));
        const dataUrl = await blobToDataUrl(compressed);
        const imageId = await saveSharedImage(dataUrl);
        image.src = dataUrl;
        image.dataset.imageId = imageId;
        image.draggable = false;
        image.alt = "붙여넣은 이미지";
        image.title = "눌러서 크기 조절";
        image.classList.remove("uploading");
      } catch (error) {
        console.error(error);
        image.remove();
        setStatus("사진 또는 붙여넣기 버튼으로 넣어 주세요", "error");
      }
    }

    adoptingImages = false;
    content.dispatchEvent(new Event("input", { bubbles: true }));
    if (content.querySelector("img:not([data-image-id])")) adoptNativeImages();
  }

  content.addEventListener("input", () => {
    if (content.querySelector("img:not([data-image-id]):not(.uploading)")) {
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

  content.addEventListener("click", (event) => {
    if (!event.target.matches("img[data-image-id]")) return;
    selectInlineImage(event.target);
    setStatus("− / + 버튼 또는 모서리 드래그로 크기 조절");
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
    requestAnimationFrame(positionImageToolbar);
    setStatus("이미지 크기 저장됨", "connected");
  }

  content.addEventListener("pointerup", finishResize);
  content.addEventListener("pointercancel", finishResize);

  content.addEventListener("dblclick", (event) => {
    if (!event.target.matches("img[data-image-id]")) return;
    event.target.removeAttribute("data-width");
    event.target.style.removeProperty("width");
    content.dispatchEvent(new Event("input", { bubbles: true }));
    requestAnimationFrame(positionImageToolbar);
  });

  content.addEventListener("keydown", (event) => {
    const selectedImage = content.querySelector("img.selected");
    if (!selectedImage || !["Backspace", "Delete"].includes(event.key)) return;
    event.preventDefault();
    selectedImage.remove();
    if (selectedInlineImage === selectedImage) hideImageToolbar();
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });

  content.addEventListener("paste", (event) => {
    const clipboard = event.clipboardData;
    const file = readClipboardImage(clipboard);
    const dataUrl = readClipboardDataUrl(clipboard);
    const text = readClipboardText(clipboard, "text/plain");
    const html = readClipboardText(clipboard, "text/html");
    const range = currentEditorRange(content);

    if (file || dataUrl) {
      event.preventDefault();
      insertInlineImage(content, range, file || dataUrl);
      return;
    }

    if (text && !/<img\b/i.test(html)) {
      event.preventDefault();
      insertPlainText(content, text);
      return;
    }

    requestAnimationFrame(() => adoptNativeImages());
  });

  const inlinePhotoInput = memo.querySelector(".inline-photo-input");
  const pasteImageButton = memo.querySelector(".paste-image");
  let toolRange = null;

  memo.querySelector(".memo-tools")?.addEventListener("pointerdown", () => {
    toolRange = currentEditorRange(content);
  });

  inlinePhotoInput?.addEventListener("change", () => {
    const file = inlinePhotoInput.files?.[0];
    inlinePhotoInput.value = "";
    if (!file) return;
    insertInlineImage(content, toolRange, file);
  });

  pasteImageButton?.addEventListener("click", async () => {
    const range = toolRange || currentEditorRange(content);
    try {
      if (!navigator.clipboard?.read) throw new Error("clipboard-read-unavailable");
      const items = await navigator.clipboard.read();
      let blob = null;
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (!type) continue;
        blob = await item.getType(type);
        break;
      }
      if (!blob) {
        setStatus("복사된 사진이 없습니다", "error");
        return;
      }
      insertInlineImage(content, range, blob);
    } catch (error) {
      console.error(error);
      setStatus("붙여넣기를 허용하거나 사진 버튼으로 넣어 주세요", "error");
    }
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
          if (selectedInlineImage?.dataset.imageId === change.doc.id) hideImageToolbar();
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
