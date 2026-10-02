const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_COUNT = 10;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function isValidImage(file) {
  if (!IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) return false;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return jpeg || png || webp;
}

export async function uploadStudyImages(fileList) {
  const files = [...fileList];
  if (files.length > MAX_IMAGE_COUNT) throw new Error(`Choose no more than ${MAX_IMAGE_COUNT} images.`);
  if (!files.length) return [];

  const invalid = [];
  for (const file of files) {
    if (!(await isValidImage(file))) invalid.push(file.name);
  }
  if (invalid.length) throw new Error(`Use valid JPG, PNG, or WebP images (each up to 25 MB). Check: ${invalid.join(", ")}`);

  const client = window.studyhubSupabase;
  if (!client) throw new Error("Image uploads are not configured. Refresh StudyHub and try again.");
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.user?.id) throw new Error("Your StudyHub sign-in expired. Sign in again before uploading images.");

  const uploadedPaths = [];
  try {
    const urls = [];
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
      const path = `${session.user.id}/community/${crypto.randomUUID()}-${safeName}`;
      const { error } = await client.storage.from("notes-uploads").upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (error) throw error;
      uploadedPaths.push(path);
      const { data } = client.storage.from("notes-uploads").getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    return urls;
  } catch (error) {
    if (uploadedPaths.length) {
      const { error: cleanupError } = await client.storage.from("notes-uploads").remove(uploadedPaths);
      if (cleanupError) console.error("[StudyHub] Could not clean up partial image uploads:", cleanupError.message);
    }
    throw error;
  }
}

export async function cleanupStudyImages(urls) {
  const client = window.studyhubSupabase;
  if (!client || !urls?.length) return;
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.user?.id) return;
  const prefix = `${session.user.id}/community/`;
  const paths = urls.map((value) => {
    try {
      const pathname = decodeURIComponent(new URL(value).pathname);
      const marker = "/storage/v1/object/public/notes-uploads/";
      return pathname.includes(marker) ? pathname.slice(pathname.indexOf(marker) + marker.length) : "";
    } catch {
      return "";
    }
  }).filter((path) => path.startsWith(prefix));
  if (!paths.length) return;
  const { error } = await client.storage.from("notes-uploads").remove(paths);
  if (error) throw error;
}

export function renderImageGallery(urls, alt = "Uploaded study image") {
  const validUrls = (Array.isArray(urls) ? urls : []).filter((value) => {
    try { return new URL(value).protocol === "https:"; } catch { return false; }
  });
  if (!validUrls.length) return null;
  const gallery = document.createElement("div");
  gallery.className = "study-image-gallery";
  validUrls.forEach((url, index) => {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const image = document.createElement("img");
    image.src = url;
    image.alt = `${alt} ${index + 1}`;
    image.loading = "lazy";
    link.append(image);
    gallery.append(link);
  });
  return gallery;
}
