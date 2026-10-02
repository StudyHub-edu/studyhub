/* ============================================================================
 * StudyHub — profile page: avatar upload + live ID card verification
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth({ allowAdmin: true });
  if (!session) return;

  let profile = await loadIdentity(session);
  if (!profile) {
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name, role, phone, class_level, institution_id, verification_status")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (error || !data) {
      console.error("[StudyHub] Could not load the profile:", error?.message || "Profile row not found.");
      showAlert(pageAlert(), "error", "Your profile could not be loaded. Please refresh the page or sign in again.");
      return;
    }
    profile = { ...data, identity_status: "unavailable", avatar_url: null, avatar_enabled: false };
    const name = profile.full_name || session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "StudyHub member";
    document.querySelectorAll("[data-identity-name]").forEach((el) => (el.textContent = name));
    const roleLabel = profile.role === "admin" ? "Administrator" : profile.role === "teacher" ? "Teacher" : "Student";
    document.querySelectorAll("[data-identity-meta]").forEach((el) => (el.textContent = roleLabel));
    renderAvatarEverywhere(null, name);
  }

  const home = homeForRole(profile.role);
  document.querySelectorAll(".topbar__brand, .topbar__nav a[href='dashboard.html']").forEach((link) => {
    link.href = home;
  });
  document.querySelectorAll(".profile-dropdown a[href='profile.html']").forEach((link) => {
    link.href = "/profile.html";
  });

  document.getElementById("email-readonly").value = session.user.email || session.user.phone || "";

  if (profile.avatar_enabled === false) {
    document.getElementById("avatar-btn").hidden = true;
  } else {
    initAvatarUpload(session);
  }
  initBasicForm(session, profile);
  if (profile.role === "admin") {
    document.getElementById("identity-verification").hidden = true;
  } else {
    renderVerifyPanel(profile);
    initScanner(session, profile);
    if (window.location.hash === "#identity-verification" && profile.identity_status !== "pending" && profile.identity_status !== "verified") {
      document.getElementById("scan-btn")?.click();
    }
  }
});

/* ------------------------------------------------------------- alerts --- */

const pageAlert = () => document.getElementById("page-alert");

/* ------------------------------------------------------ avatar upload --- */

function initAvatarUpload(session) {
  const btn = document.getElementById("avatar-btn");
  const input = document.getElementById("avatar-input");

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showAlert(pageAlert(), "error", "Please choose an image under 5 MB.");
      input.value = "";
      return;
    }

    btn.disabled = true;
    clearAlert(pageAlert());

    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, cacheControl: "3600" });
      if (uploadError) throw uploadError;

      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const avatarUrl = pub.publicUrl;

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: avatarUrl })
        .eq("user_id", session.user.id);
      if (updateError) throw updateError;

      renderAvatarEverywhere(avatarUrl, document.querySelector("[data-identity-name]")?.textContent || "");
      showAlert(pageAlert(), "success", "Profile photo updated ✓");
    } catch (err) {
      console.debug("[StudyHub] avatar upload failed:", err);
      showAlert(pageAlert(), "error", friendlyError(err));
    } finally {
      btn.disabled = false;
      input.value = "";
    }
  });
}

/* ------------------------------------------------------- basic details -- */

function initBasicForm(session, profile) {
  const form = document.getElementById("basic-form");
  const fullName = document.getElementById("full-name");
  const phone = document.getElementById("phone");
  const saveBtn = document.getElementById("basic-save-btn");

  fullName.value = profile.full_name || "";
  phone.value = profile.phone || "";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(pageAlert());

    if (!fullName.value.trim()) {
      showAlert(pageAlert(), "error", "Please enter your full name.");
      fullName.focus();
      return;
    }

    setLoading(saveBtn, true, "Saving…");

    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName.value.trim(), phone: phone.value.trim() || null })
        .eq("user_id", session.user.id);
      if (error) throw error;

      document.querySelectorAll("[data-identity-name]").forEach((el) => (el.textContent = fullName.value.trim()));
      showAlert(pageAlert(), "success", "Saved ✓");
    } catch (err) {
      showAlert(pageAlert(), "error", friendlyError(err));
    } finally {
      setLoading(saveBtn, false);
    }
  });
}

/* --------------------------------------------------------- verify panel - */

function renderVerifyPanel(profile) {
  const badge = document.getElementById("identity-badge");
  const views = {
    not_submitted: document.getElementById("verify-start"),
    pending: document.getElementById("verify-pending"),
    verified: document.getElementById("verify-verified"),
    rejected: document.getElementById("verify-rejected"),
  };

  Object.values(views).forEach((el) => (el.hidden = true));
  const status = profile.identity_status || "not_submitted";
  (views[status] || views.not_submitted).hidden = false;

  const badgeText = {
    not_submitted: "Not verified yet",
    pending: "Pending review",
    verified: "Verified",
    rejected: "Needs another scan",
  };
  const badgeClass = {
    not_submitted: "id-badge id-badge--muted",
    pending: "id-badge id-badge--pending",
    verified: "id-badge id-badge--verified",
    rejected: "id-badge id-badge--rejected",
  };
  badge.textContent = badgeText[status] || badgeText.not_submitted;
  badge.className = badgeClass[status] || badgeClass.not_submitted;
}

async function refreshVerifyPanelFromServer(session) {
  const { data } = await supabase
    .from("profiles")
    .select("identity_status")
    .eq("user_id", session.user.id)
    .maybeSingle();

  const { data: latest } = await supabase
    .from("identity_verifications")
    .select("created_at, status, review_note")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) renderVerifyPanel(data);

  if (latest) {
    const dateText = new Date(latest.created_at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const pendingDate = document.getElementById("pending-date");
    const verifiedDate = document.getElementById("verified-date");
    const rejectedNote = document.getElementById("rejected-note");
    if (pendingDate) pendingDate.textContent = dateText;
    if (verifiedDate) verifiedDate.textContent = dateText;
    if (rejectedNote && latest.review_note) {
      rejectedNote.textContent = latest.review_note;
    }
  }
}

/* ------------------------------------------------------------- scanner -- */

function initScanner(session, profile) {
  const openBtns = [document.getElementById("scan-btn"), document.getElementById("rescan-btn")].filter(Boolean);
  const overlay = document.getElementById("scan-overlay");
  const closeBtn = document.getElementById("scan-close");
  const video = document.getElementById("scan-video");
  const canvas = document.getElementById("scan-canvas");
  const hint = document.getElementById("scan-hint");
  const foundBox = document.getElementById("scan-found");
  const foundName = document.getElementById("found-name");
  const foundInstitution = document.getElementById("found-institution");
  const foundClass = document.getElementById("found-class");
  const foundOcrText = document.getElementById("found-ocr-text");
  const trackerPolygon = document.getElementById("scan-tracker-polygon");
  const trackerStatus = document.getElementById("scan-tracker-status");
  const captureButton = document.getElementById("scan-capture");
  const photoButton = document.getElementById("scan-photo-button");
  const photoInput = document.getElementById("scan-photo-input");
  const videoWrap = video.closest(".scan-video-wrap");
  const trackingCanvas = document.createElement("canvas");
  const trackingContext = trackingCanvas.getContext("2d", { willReadFrequently: true });

  let stream = null;
  let scanTimer = null;
  let trackerTimer = null;
  let stopped = false;
  let scanInProgress = false;
  let captureInProgress = false;
  let trackerInProgress = false;
  let trackerReady = false;
  let stableTrackFrames = 0;
  let trackerReadyAt = 0;
  let restartingAfterPicker = false;
  let institutionsList = [];
  const SCAN_INTERVAL_MS = 1400;

  async function loadInstitutions() {
    if (institutionsList.length) return institutionsList;
    try {
      const { data, error } = await supabase.from("institutions").select("id, name");
      if (error) throw error;
      institutionsList = data || [];
    } catch (err) {
      console.debug("[StudyHub] institutions load for OCR match failed:", err.message);
    }
    return institutionsList;
  }

  /* ------------------------------------------------- text-field parsing */

  function parseIdCardText(raw) {
    const text = raw.replace(/\r/g, "");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let name = null;
    let classLevel = null;
    let expiryDate = null;

    for (const line of lines) {
      const m = line.match(/name\s*[:\-]\s*(.+)/i);
      if (m && !name) name = cleanField(m[1]);
    }
    if (!name) {
      // Fallback: the longest mostly-alphabetic, mostly-uppercase line that
      // isn't obviously a label ("STUDENT ID CARD", school name, etc).
      const candidates = lines.filter(
        (l) =>
          /^[A-Z][A-Z.'\- ]{3,40}$/.test(l) &&
          !/CARD|SCHOOL|COLLEGE|INSTITUTE|ACADEMY|UNIVERSITY|VALID|CLASS|GRADE/i.test(l)
      );
      if (candidates.length) name = cleanField(candidates.sort((a, b) => b.length - a.length)[0]);
    }

    const classMatch = text.match(/(class|grade)\s*[:\-]?\s*([0-9]{1,2}(st|nd|rd|th)?|[ivxlcdm]+)/i);
    if (classMatch) {
      classLevel = /^[0-9]/.test(classMatch[2]) ? `Grade ${classMatch[2].replace(/[a-z]/gi, "")}` : classMatch[2];
    }

    const dateMatch = text.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/);
    const yearOnlyMatch = text.match(/(valid|expiry|exp|till|until|upto)\D{0,6}(20\d{2})/i);
    if (dateMatch) {
      expiryDate = normalizeDate(dateMatch[1]);
    } else if (yearOnlyMatch) {
      expiryDate = `${yearOnlyMatch[2]}-12-31`;
    }

    const institutionRaw = lines.find((l) => /school|college|institute|academy|university/i.test(l)) || null;
    const institutionMatch = matchInstitution(text, institutionsList);

    return {
      extractedText: text.slice(0, 4000),
      name,
      classLevel,
      expiryDate,
      institutionRaw,
      institutionId: institutionMatch?.id || null,
      institutionName: institutionMatch?.name || institutionRaw,
    };
  }

  function cleanField(value) {
    return value
      .replace(/[^A-Za-z.'\- ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function normalizeDate(raw) {
    const parts = raw.split(/[\/\-.]/).map((p) => p.trim());
    if (parts.length !== 3) return null;
    let [a, b, c] = parts;
    if (c.length === 2) c = (Number(c) > 50 ? "19" : "20") + c;
    // Assume DD/MM/YYYY, the common non-US convention on ID cards.
    const day = a.padStart(2, "0");
    const month = b.padStart(2, "0");
    if (Number(month) > 12) return null;
    return `${c}-${month}-${day}`;
  }

  function matchInstitution(text, list) {
    const lower = text.toLowerCase();
    let best = null;
    for (const inst of list) {
      if (inst.name && lower.includes(inst.name.toLowerCase())) {
        if (!best || inst.name.length > best.name.length) best = inst;
      }
    }
    return best;
  }

  function isGoodEnough(fields) {
    return Boolean(fields.name) && Boolean(fields.institutionId || fields.classLevel);
  }

  /* --------------------------------------------------------- camera loop */

  async function openScanner() {
    stopped = false;
    trackerReady = false;
    stableTrackFrames = 0;
    trackerPolygon.setAttribute("points", "");
    videoWrap.classList.remove("is-tracking");
    overlay.hidden = false;
    hint.textContent = "Hold your ID flat inside the frame, in good light.";
    trackerStatus.textContent = "Looking for your ID card…";
    foundBox.hidden = true;
    foundName.textContent = "—";
    foundInstitution.textContent = "—";
    foundClass.textContent = "—";
    foundOcrText.textContent = "";
    captureButton.disabled = true;
    captureButton.textContent = "Capture ID photo & send for review";

    await loadInstitutions();

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (firstErr) {
        // Most laptops only have a front-facing camera and can reject a
        // strict "environment" request outright — fall back to any camera.
        console.debug("[StudyHub] environment camera unavailable, trying default:", firstErr.message);
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      video.srcObject = stream;
      await video.play();
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("The camera opened, but no video frame became available. Check that the camera is not covered or in use by another app."));
          }, 5000);
          const onReady = () => {
            if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
            cleanup();
            resolve();
          };
          const cleanup = () => {
            clearTimeout(timeout);
            video.removeEventListener("loadeddata", onReady);
            video.removeEventListener("playing", onReady);
          };
          video.addEventListener("loadeddata", onReady);
          video.addEventListener("playing", onReady);
          onReady();
        });
      }
      captureButton.disabled = false;
    } catch (err) {
      const deniedMsg = err.name === "NotAllowedError"
        ? "Camera access was blocked. Allow camera access for this site in your browser's address bar, then reload and try again."
        : err.name === "NotFoundError"
          ? "No camera was found. Connect or enable a camera, then try again."
          : err.name === "NotReadableError"
            ? "The camera is busy or unavailable. Close other apps using it, then try again."
            : err.name === "SecurityError"
              ? "Camera access requires a secure HTTPS site or localhost. If you host StudyHub, enable HTTPS and allow camera access in the site's Permissions-Policy."
              : "Couldn't access your camera. Check the browser's camera permission and try again.";
      hint.textContent = deniedMsg;
      showAlert(pageAlert(), "error", deniedMsg);
      console.debug("[StudyHub] camera error:", err);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return;
    }

    startIdCardTracker();
    scanTimer = setInterval(async () => {
      if (stopped) return;
      hint.textContent = stableTrackFrames >= 3
        ? "ID is in position. Check the frame, then tap Capture ID photo."
        : "Place the whole ID card inside the guide, then tap Capture ID photo.";
      if (scanInProgress || captureInProgress) return;
      scanInProgress = true;

      try {
        const canvasCtx = canvas.getContext("2d");
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const {
          data: { text },
        } = await Tesseract.recognize(canvas, "eng");

        const fields = parseIdCardText(text);

        if (text.trim() || fields.name || fields.institutionName || fields.classLevel) {
          foundBox.hidden = false;
          foundName.textContent = fields.name || "—";
          foundInstitution.textContent = fields.institutionName || "—";
          foundClass.textContent = fields.classLevel || "—";
          foundOcrText.textContent = fields.extractedText || "";
        }

      } catch (err) {
        console.debug("[StudyHub] OCR pass failed:", err.message);
      } finally {
        scanInProgress = false;
      }
    }, SCAN_INTERVAL_MS);
  }

  function stopScanLoopOnly() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (trackerTimer) clearInterval(trackerTimer);
    trackerTimer = null;
    trackerInProgress = false;
    trackerPolygon.setAttribute("points", "");
    videoWrap.classList.remove("is-tracking");
  }

  async function startIdCardTracker() {
    trackerStatus.textContent = "Starting the automatic card tracker…";
    const deadline = Date.now() + 15000;
    while (!stopped && Date.now() < deadline && (!window.cv || !window.cv.Mat)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (stopped) return;
    if (!window.cv || !window.cv.Mat) {
      trackerStatus.textContent = "Automatic tracking is unavailable. Keep the full card inside the guide; text scanning will still work.";
      return;
    }

    trackerReady = true;
    trackerReadyAt = Date.now();
    trackerStatus.textContent = "Move the card into view; the green outline will follow it.";
    trackerTimer = setInterval(trackIdCardFrame, 180);
  }

  function trackIdCardFrame() {
    if (stopped || trackerInProgress || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    trackerInProgress = true;
    const cv = window.cv;
    let source;
    let gray;
    let edges;
    let contours;
    let hierarchy;
    try {
      const width = 320;
      const height = Math.max(180, Math.round(width * video.videoHeight / video.videoWidth));
      trackingCanvas.width = width;
      trackingCanvas.height = height;
      trackingContext.drawImage(video, 0, 0, width, height);
      source = cv.imread(trackingCanvas);
      gray = new cv.Mat();
      edges = new cv.Mat();
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 60, 150);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      let best = null;
      let bestScore = 0;
      const frameArea = width * height;
      for (let i = 0; i < contours.size(); i += 1) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < frameArea * 0.07 || area > frameArea * 0.92) {
          contour.delete();
          continue;
        }
        const perimeter = cv.arcLength(contour, true);
        const polygon = new cv.Mat();
        cv.approxPolyDP(contour, polygon, perimeter * 0.025, true);
        contour.delete();
        if (polygon.rows !== 4 || !cv.isContourConvex(polygon)) {
          polygon.delete();
          continue;
        }

        const bounds = cv.boundingRect(polygon);
        const ratio = bounds.width / Math.max(1, bounds.height);
        if (ratio < 1.25 || ratio > 2.15) {
          polygon.delete();
          continue;
        }
        const centerDistance = Math.hypot(
          (bounds.x + bounds.width / 2) / width - 0.5,
          (bounds.y + bounds.height / 2) / height - 0.5
        );
        const score = area * Math.max(0.2, 1 - centerDistance);
        if (score > bestScore) {
          if (best) best.delete();
          best = polygon;
          bestScore = score;
        } else {
          polygon.delete();
        }
      }

      if (best) {
        const points = Array.from(best.data32S);
        const svgPoints = [];
        for (let i = 0; i < points.length; i += 2) {
          svgPoints.push(`${(points[i] / width) * 100},${(points[i + 1] / height) * 100}`);
        }
        trackerPolygon.setAttribute("points", svgPoints.join(" "));
        videoWrap.classList.add("is-tracking");
        stableTrackFrames = Math.min(stableTrackFrames + 1, 10);
        trackerStatus.textContent = stableTrackFrames >= 3
          ? "ID card tracked. Hold it steady for text scanning."
          : "Card detected. Keep it steady…";
        best.delete();
      } else {
        trackerPolygon.setAttribute("points", "");
        videoWrap.classList.remove("is-tracking");
        stableTrackFrames = 0;
        trackerStatus.textContent = "Looking for the card — place the whole ID inside the guide.";
      }
    } catch (err) {
      console.debug("[StudyHub] ID card tracking failed:", err.message);
      trackerStatus.textContent = "Automatic tracking paused. Keep the full card inside the guide; text scanning will continue.";
      stableTrackFrames = 0;
    } finally {
      if (source) source.delete();
      if (gray) gray.delete();
      if (edges) edges.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
      trackerInProgress = false;
    }
  }

  function closeScanner() {
    stopped = true;
    stopScanLoopOnly();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    overlay.hidden = true;
  }

  async function submitIdImage(image, fields) {
    stopped = true;
    captureButton.disabled = true;
    photoButton.disabled = true;
    stopScanLoopOnly();
    hint.textContent = "Got it — submitting for review…";
    let path = null;
    let uploaded = false;

    try {
      const extension = image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg";
      path = `${session.user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("id-cards").upload(path, image, {
        contentType: image.type,
        upsert: false,
      });
      if (uploadError) throw uploadError;
      uploaded = true;

      const { error: insertError } = await supabase.from("identity_verifications").insert({
        user_id: session.user.id,
        role_at_submission: profile.role,
        image_path: path,
        extracted_full_name: fields.name,
        extracted_institution_id: fields.institutionId,
        extracted_institution_raw: fields.institutionRaw,
        extracted_class_level: fields.classLevel,
        extracted_expiry_date: fields.expiryDate,
        extracted_text: fields.extractedText,
      });
      if (insertError) throw insertError;

      path = null;
      closeScanner();
      showAlert(
        pageAlert(),
        "success",
        "Your ID photo was submitted successfully. An admin will review it shortly."
      );
      await refreshVerifyPanelFromServer(session);
      if (fields.name) document.getElementById("full-name").value = fields.name;
      return true;
    } catch (err) {
      if (uploaded && path) {
        const { error: cleanupError } = await supabase.storage.from("id-cards").remove([path]);
        if (cleanupError) console.error("[StudyHub] Could not remove unsubmitted ID photo:", cleanupError.message);
      }
      console.error("[StudyHub] ID submission failed:", err);
      hint.textContent = "Your photo was not submitted. Please try again.";
      showAlert(pageAlert(), "error", friendlyError(err));
      stopped = false;
      captureButton.disabled = false;
      captureButton.textContent = "Capture ID photo & send for review";
      photoButton.disabled = false;
      return false;
    }
  }

  async function finishScan(fields, capturedCanvas) {
    try {
      const blob = await new Promise((resolve) => capturedCanvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("Could not capture the ID photo. Please try again.");
      await submitIdImage(blob, fields);
    } catch (err) {
      console.error("[StudyHub] Could not prepare the captured ID photo:", err);
      hint.textContent = "Could not prepare the captured photo. Please try again.";
      showAlert(pageAlert(), "error", friendlyError(err));
      stopped = false;
      captureButton.disabled = false;
      photoButton.disabled = false;
    }
  }

  function restartCameraAfterPicker() {
    if (restartingAfterPicker) return;
    restartingAfterPicker = true;
    openScanner().finally(() => { restartingAfterPicker = false; });
  }

  photoButton.addEventListener("click", () => {
    stopScanLoopOnly();
    stopped = true;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    photoInput.click();
  });

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file) {
      restartCameraAfterPicker();
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)
      || file.size > 10 * 1024 * 1024
      || !(await isSupportedImageFile(file))) {
      showAlert(pageAlert(), "error", "Choose a valid JPG, PNG, or WebP ID photo under 10 MB.");
      restartCameraAfterPicker();
      return;
    }
    captureInProgress = true;
    foundBox.hidden = false;
    foundOcrText.textContent = "Photo selected. Sending it to an admin for review…";
    const submitted = await submitIdImage(file, {
      extractedText: "",
      name: null,
      classLevel: null,
      expiryDate: null,
      institutionRaw: null,
      institutionId: null,
    });
    captureInProgress = false;
    if (!submitted) restartCameraAfterPicker();
  });

  async function captureAndSubmit() {
    if (stopped || captureInProgress || !stream) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      const message = "The camera is not ready yet. Wait for the live preview, then try again.";
      hint.textContent = message;
      showAlert(pageAlert(), "error", message);
      return;
    }
    captureButton.disabled = true;
    captureButton.textContent = "Sending photo for review…";
    hint.textContent = "Capturing your ID photo and sending it to the admin for review…";
    captureInProgress = true;
    stopScanLoopOnly();
    const fields = {
      extractedText: "",
      name: null,
      classLevel: null,
      expiryDate: null,
      institutionRaw: null,
      institutionId: null,
      institutionName: null,
    };
    try {
      const capturedCanvas = document.createElement("canvas");
      capturedCanvas.width = video.videoWidth;
      capturedCanvas.height = video.videoHeight;
      capturedCanvas.getContext("2d").drawImage(video, 0, 0, capturedCanvas.width, capturedCanvas.height);
      foundBox.hidden = false;
      foundOcrText.textContent = "Photo captured. The admin will review the image.";
      await finishScan(fields, capturedCanvas);
    } catch (error) {
      console.error("[StudyHub] Could not capture the ID photo:", error);
      const message = error.message || "Could not capture the ID photo. Please try again.";
      hint.textContent = message;
      showAlert(pageAlert(), "error", message);
      captureButton.disabled = false;
      captureButton.textContent = "Capture ID photo & send for review";
      photoButton.disabled = false;
    } finally {
      captureInProgress = false;
    }
  }

  photoInput.addEventListener("cancel", restartCameraAfterPicker);

  captureButton.addEventListener("click", captureAndSubmit);
  openBtns.forEach((btn) => btn.addEventListener("click", openScanner));
  closeBtn.addEventListener("click", closeScanner);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeScanner();
  });
}
