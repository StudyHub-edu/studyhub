/* ============================================================================
 * StudyHub — AI Teacher chat logic
 * Loaded after config.js, auth.js, and dashboard-nav.js on ai-teacher.html.
 * Talks to the "ai-teacher" Supabase Edge Function (see
 * supabase/functions/ai-teacher/index.ts) — never calls the AI provider
 * directly, so no API key is ever exposed in this file.
 * ========================================================================== */

let currentSession = null;
let chatHistory = []; // [{role:'user'|'assistant', content, image_path?}]
let selectedImage = null; // { blob, base64, mediaType, previewUrl }

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* --------------------------------------------------------------- image resize */

function resizeImage(file, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => (img.src = reader.result);
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      canvas.toBlob(
        (blob) => resolve({ blob, base64: dataUrl.split(",")[1], mediaType: "image/jpeg", previewUrl: dataUrl }),
        "image/jpeg",
        quality
      );
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ----------------------------------------------------------------- rendering */

function formatAssistantMarkdown(markdown) {
  const inline = (value) => {
    let html = escapeHtml(value);
    const codeFragments = [];

    html = html.replace(/`([^`]+)`/g, (_, code) => {
      const token = `\u0000CODE${codeFragments.length}\u0000`;
      codeFragments.push(`<code>${code}</code>`);
      return token;
    });

    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    );
    html = html
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
      .replace(/~~(.+?)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

    return html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeFragments[Number(index)]);
  };

  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let codeLines = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      blocks.push(`<${listType}>${listItems.map((item) => `<li>${inline(item)}</li>`).join("")}</${listType}>`);
      listType = null;
      listItems = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (codeLines) {
      if (/^```/.test(trimmed)) {
        blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = null;
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (/^```/.test(trimmed)) {
      flushParagraph();
      flushList();
      codeLines = [];
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s*(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2].replace(/^-\s*/, ""))}</h${level}>`);
      continue;
    }
    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
      continue;
    }

    const listItem = trimmed.match(/^(?:([-*+])\s*|(\d+)[.)]\s*)(.*)$/);
    if (listItem) {
      flushParagraph();
      const type = listItem[2] ? "ol" : "ul";
      if (listType && listType !== type) flushList();
      listType = type;
      listItems.push(listItem[3]);
      continue;
    }
    flushList();

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  if (codeLines) blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return blocks.join("");
}

function renderMessage({ role, content, imageUrl, created_at }) {
  const container = document.getElementById("messages");
  document.getElementById("empty-state")?.remove();

  const wrap = document.createElement("div");
  wrap.className = `ai-msg ai-msg--${role}`;
  wrap.innerHTML = `
    ${role === "assistant" ? `<span class="ai-msg__avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><rect x="7" y="7" width="10" height="10" rx="3"/></svg></span>` : ""}
    <div class="ai-msg__bubble">
      ${imageUrl ? `<img class="ai-msg__image" src="${imageUrl}" alt="Uploaded question" />` : ""}
      <div class="ai-msg__text">${role === "assistant" ? formatAssistantMarkdown(content) : escapeHtml(content)}</div>
      ${created_at ? `<div class="ai-msg__time">${formatTime(created_at)}</div>` : ""}
    </div>`;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return wrap;
}

function renderTyping() {
  const container = document.getElementById("messages");
  const wrap = document.createElement("div");
  wrap.className = "ai-msg ai-msg--assistant";
  wrap.id = "typing-indicator";
  wrap.innerHTML = `
    <span class="ai-msg__avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><rect x="7" y="7" width="10" height="10" rx="3"/></svg></span>
    <div class="ai-msg__bubble"><div class="ai-typing"><span></span><span></span><span></span></div></div>`;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

function removeTyping() {
  document.getElementById("typing-indicator")?.remove();
}

/* -------------------------------------------------------------- history */

async function loadHistory() {
  try {
    const { data, error } = await supabase
      .from("ai_chat_messages")
      .select("role, content, image_path, created_at")
      .eq("user_id", currentSession.user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    if (!data || !data.length) return;

    for (const row of data.reverse()) {
      let imageUrl = null;
      if (row.image_path) {
        const { data: signed } = await supabase.storage.from("ai-teacher-uploads").createSignedUrl(row.image_path, 3600);
        imageUrl = signed?.signedUrl || null;
      }
      renderMessage({ role: row.role, content: row.content, imageUrl, created_at: row.created_at });
      chatHistory.push({ role: row.role, content: row.content });
    }
  } catch (err) {
    const message = isMissingTable(err)
      ? "Chat history is not set up yet. Run ai_teacher_schema.sql in Supabase to save conversations."
      : `Chat history could not be loaded: ${err.message}`;
    const status = document.getElementById("composer-status");
    status.textContent = message;
    status.classList.add("is-visible");
    console.error("[AI Teacher] history load failed:", err);
  }
}

async function persistMessage(role, content, imagePath = null) {
  try {
    const { error } = await supabase.from("ai_chat_messages").insert({
      user_id: currentSession.user.id,
      role,
      content,
      image_path: imagePath,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[AI Teacher] persist failed:", err);
    return false;
  }
}

async function getFunctionErrorMessage(error) {
  const response = error?.context;
  if (response && typeof response.clone === "function") {
    try {
      const payload = await response.clone().json();
      if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
      if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
    } catch (parseError) {
      console.error("[AI Teacher] could not read function error response:", parseError);
    }

    if (response.status) {
      return `AI Teacher service returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
    }
  }

  return error?.message || "The AI Teacher service could not be reached.";
}

async function clearHistory() {
  if (!confirm("Clear your AI Teacher chat history? This can't be undone.")) return;
  try {
    const { error } = await supabase.from("ai_chat_messages").delete().eq("user_id", currentSession.user.id);
    if (error) throw error;
  } catch (err) {
    const status = document.getElementById("composer-status");
    status.textContent = `Chat history could not be cleared: ${err.message}`;
    status.classList.add("is-visible");
    console.error("[AI Teacher] clear failed:", err);
    return;
  }
  chatHistory = [];
  document.getElementById("messages").innerHTML = document.getElementById("empty-state-template").innerHTML;
  bindSuggestions();
}

/* --------------------------------------------------------------- sending */

async function sendMessage(text) {
  const status = document.getElementById("composer-status");
  status.classList.remove("is-visible");

  if (!text.trim() && !selectedImage) return;

  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = true;

  let imagePath = null;
  let imagePreviewUrl = selectedImage?.previewUrl || null;

  renderMessage({ role: "user", content: text, imageUrl: imagePreviewUrl, created_at: new Date().toISOString() });
  renderTyping();

  try {
    if (selectedImage) {
      const path = `${currentSession.user.id}/${Date.now()}.jpg`;
      const { error: uploadError } = await supabase.storage.from("ai-teacher-uploads").upload(path, selectedImage.blob);
      if (!uploadError) imagePath = path;
    }

    const userMessageSaved = await persistMessage("user", text, imagePath);

    const { data, error } = await supabase.functions.invoke("ai-teacher", {
      body: {
        message: text,
        imageBase64: selectedImage?.base64 || null,
        imageMediaType: selectedImage?.mediaType || null,
        history: chatHistory.slice(-40),
      },
    });

    removeTyping();

    if (error) throw new Error(await getFunctionErrorMessage(error));
    if (data?.error) throw new Error(data.error);

    const reply = data.reply;
    if (typeof reply !== "string" || !reply.trim()) {
      throw new Error("The AI Teacher service returned an empty reply.");
    }
    renderMessage({ role: "assistant", content: reply, created_at: new Date().toISOString() });
    const assistantMessageSaved = await persistMessage("assistant", reply);

    chatHistory.push({ role: "user", content: text });
    chatHistory.push({ role: "assistant", content: reply });
    if (!userMessageSaved || !assistantMessageSaved) {
      status.textContent = "This reply could not be saved to chat history. Run ai_teacher_schema.sql in Supabase to enable memory across visits.";
      status.classList.add("is-visible");
    }
  } catch (err) {
    removeTyping();
    console.error("[AI Teacher] send failed:", err);
    const detail = String(err?.message || "Unknown service error").slice(0, 300);
    status.textContent = detail;
    status.classList.add("is-visible");
    renderMessage({
      role: "assistant",
      content: `AI Teacher couldn't reply: ${detail}`,
      created_at: new Date().toISOString(),
    });
  } finally {
    sendBtn.disabled = false;
    clearComposerImage();
  }
}

/* -------------------------------------------------------------- composer */

function clearComposerImage() {
  selectedImage = null;
  document.getElementById("image-input").value = "";
  document.getElementById("composer-preview").classList.remove("has-image");
}

function bindSuggestions() {
  document.querySelectorAll(".ai-suggestion").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.getElementById("text-input").value = btn.dataset.prompt;
      document.getElementById("composer-form").requestSubmit();
    })
  );
}

function initComposer() {
  const form = document.getElementById("composer-form");
  const textInput = document.getElementById("text-input");
  const imageInput = document.getElementById("image-input");
  const preview = document.getElementById("composer-preview");
  const previewImg = document.getElementById("composer-preview-img");

  textInput.addEventListener("input", () => {
    textInput.style.height = "auto";
    textInput.style.height = Math.min(textInput.scrollHeight, 120) + "px";
  });

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    try {
      selectedImage = await resizeImage(file);
      previewImg.src = selectedImage.previewUrl;
      preview.classList.add("has-image");
    } catch (err) {
      console.debug("[AI Teacher] image resize failed:", err.message);
    }
  });

  document.getElementById("remove-image").addEventListener("click", clearComposerImage);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = textInput.value;
    textInput.value = "";
    textInput.style.height = "auto";
    sendMessage(text);
  });

  document.getElementById("clear-chat").addEventListener("click", clearHistory);
}

/* ------------------------------------------------------------------- boot */

(async () => {
  const session = await requireAuth();
  if (!session) return;
  currentSession = session;

  // Keep an unmodified copy of the empty-state markup so "Clear chat" can restore it.
  const emptyTemplate = document.createElement("template");
  emptyTemplate.id = "empty-state-template";
  emptyTemplate.innerHTML = document.getElementById("empty-state").outerHTML;
  document.body.appendChild(emptyTemplate);

  initComposer();
  bindSuggestions();

  await loadIdentity(session); // shared version from auth.js: handles avatar photo + verified badge too
  await loadHistory();
})();
