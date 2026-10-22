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

        const convert = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error("이미지 변환 실패"));
              return;
            }
            if (blob.size <= maxBytes) {
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
          }, "image/webp", quality);
        };

        convert();
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

  content.addEventListener("input", () => {
    const currentImageIds = getImageIds(content);
    for (const imageId of knownImageIds) {
      if (!currentImageIds.has(imageId)) deleteSharedImage?.(imageId);
    }
    knownImageIds = currentImageIds;
    saveLocalMemo();
    scheduleSave(`memo-${index}-content`, getEditorValue(content));
  });

  content.addEventListener("click", (event) => {
    content.querySelectorAll("img.selected").forEach((image) => image.classList.remove("selected"));
    if (!event.target.matches("img[data-image-id]")) return;
    event.target.classList.add("selected");
    setStatus("우측 아래를 드래그해 크기 조절 · Delete로 삭제");
  });

  content.addEventListener("pointerdown", (event) => {
    if (!event.target.matches("img[data-image-id]")) return;
    const image = event.target;
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
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });

  content.addEventListener("paste", async (event) => {
    const imageItem = [...event.clipboardData.items]
      .find((item) => item.kind === "file" && item.type.startsWith("image/"));
    event.preventDefault();

    if (!imageItem) {
      insertPlainText(content, event.clipboardData.getData("text/plain"));
      return;
    }

    if (!saveSharedImage) {
      setStatus("이미지 공유 연결 중...", "error");
      return;
    }

    const selection = window.getSelection();
    const range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

    try {
      setStatus("붙여넣은 이미지 업로드 중...");
      const blob = await compressInlineImage(imageItem.getAsFile());
      const dataUrl = await blobToDataUrl(blob);
      const imageId = await saveSharedImage(dataUrl);
      const fragment = document.createDocumentFragment();
      const image = document.createElement("img");
      image.src = dataUrl;
      image.dataset.imageId = imageId;
      image.alt = "붙여넣은 이미지";
      image.title = "클릭 후 우측 아래를 드래그해 크기 조절";
      fragment.append(image, document.createElement("br"));
      insertNodeAtRange(content, range, fragment);
      setStatus("이미지 공유됨", "connected");
    } catch (error) {
      console.error(error);
      setStatus("이미지 업로드 실패", "error");
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
