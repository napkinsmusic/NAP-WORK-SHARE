import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
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
  content.value = saved.content || "";

  function saveLocalMemo() {
    localStorage.setItem(localKey, JSON.stringify({
      title: title.value,
      content: content.value
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
    get: () => content.value,
    set: (value) => {
      if (document.activeElement !== content) content.value = value;
      saveLocalMemo();
    }
  });

  title.addEventListener("input", () => {
    saveLocalMemo();
    scheduleSave(`memo-${index}-title`, title.value);
  });

  content.addEventListener("input", () => {
    saveLocalMemo();
    scheduleSave(`memo-${index}-content`, content.value);
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
    const uid = credential.user.uid;
    const memberRef = doc(db, "boards", boardId, "members", uid);
    const requestRef = doc(db, "boards", boardId, "accessRequests", uid);
    let sharingStarted = false;

    function startSharing() {
      if (sharingStarted) return;
      sharingStarted = true;

      writeRemote = (fieldId, value) => setDoc(
        doc(db, "boards", boardId, "fields", fieldId),
        {
          value,
          updatedAt: serverTimestamp(),
          updatedBy: uid
        }
      );

      for (const [fieldId, binding] of bindings) {
        const fieldRef = doc(db, "boards", boardId, "fields", fieldId);
        let initialized = false;

        onSnapshot(fieldRef, async (snapshot) => {
          if (snapshot.exists()) {
            binding.set(String(snapshot.data().value ?? ""));
          } else if (!initialized) {
            initialized = true;
            await writeRemote(fieldId, binding.get());
          }
        }, (error) => {
          console.error(error);
          setStatus("실시간 연결 오류", "error");
        });
      }

      setStatus("승인된 팀원 · 실시간 공유됨", "connected");
    }

    onSnapshot(memberRef, async (snapshot) => {
      if (snapshot.exists() && snapshot.data().active === true) {
        startSharing();
        return;
      }

      writeRemote = null;
      await setDoc(requestRef, {
        uid,
        requestedAt: serverTimestamp()
      });
      setStatus("팀원 승인 대기 중", "error");
    }, (error) => {
      console.error(error);
      setStatus("팀원 권한 확인 실패", "error");
    });
  } catch (error) {
    console.error(error);
    setStatus("Firebase 연결 실패", "error");
  }
}

connectFirebase();
