// Unsigned Cloudinary upload straight from the browser. No server code.
// When the Cloudinary env vars are empty, uploads are faked with local object URLs.

const CLOUD = (process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD ?? "").trim();
const PRESET = (process.env.NEXT_PUBLIC_CLOUDINARY_PRESET ?? "").trim();

export const IS_MOCK_UPLOAD = CLOUD === "" || PRESET === "";

export const MAX_CLIP_BYTES = 40 * 1024 * 1024; // 40 MB
export const MIN_CLIPS = 3;
export const MAX_CLIPS = 20;

export interface UploadedClip {
  url: string;
  publicId: string;
  duration: number;
  width: number;
  height: number;
  thumbUrl: string;
  thumbIsVideo: boolean;
}

/** Thumbnail for a Cloudinary video URL: insert so_1/ after /upload/ and use .jpg. */
export function thumbnailUrl(videoUrl: string): string {
  return videoUrl.replace("/upload/", "/upload/so_1/").replace(/\.[^./?]+(\?.*)?$/, ".jpg");
}

/** The contract shows clip URLs as .mp4, so phone .mov uploads are requested as .mp4. */
function asMp4(videoUrl: string): string {
  return videoUrl.replace(/\.[^./?]+(\?.*)?$/, ".mp4");
}

function abortError(): Error {
  const e = new Error("Upload cancelled.");
  e.name = "AbortError";
  return e;
}

function probeVideo(objectUrl: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const finish = (value: number) => {
      clearTimeout(timer);
      resolve({
        duration: Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : 10,
        width: video.videoWidth || 1080,
        height: video.videoHeight || 1920,
      });
    };
    const timer = setTimeout(() => finish(10), 2500);
    video.preload = "metadata";
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(10);
    video.src = objectUrl;
  });
}

async function mockUpload(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<UploadedClip> {
  const objectUrl = URL.createObjectURL(file);
  const probePromise = probeVideo(objectUrl);
  for (let p = 0; p <= 100; p += 5 + Math.round(Math.random() * 6)) {
    if (signal.aborted) {
      URL.revokeObjectURL(objectUrl);
      throw abortError();
    }
    onProgress(Math.min(p, 99));
    await new Promise((r) => setTimeout(r, 110));
  }
  const probed = await probePromise;
  onProgress(100);
  return {
    url: objectUrl,
    publicId: "ahoj/mock-" + Math.random().toString(36).slice(2, 10),
    ...probed,
    thumbUrl: objectUrl,
    thumbIsVideo: true,
  };
}

export function uploadClip(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<UploadedClip> {
  if (IS_MOCK_UPLOAD) return mockUpload(file, onProgress, signal);

  return new Promise<UploadedClip>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    form.append("upload_preset", PRESET);

    xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUD}/video/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      let json: {
        secure_url?: string;
        public_id?: string;
        duration?: number;
        width?: number;
        height?: number;
        error?: { message?: string };
      } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // handled below
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.secure_url && json.public_id) {
        onProgress(100);
        resolve({
          url: asMp4(json.secure_url),
          publicId: json.public_id,
          duration: typeof json.duration === "number" ? json.duration : 0,
          width: typeof json.width === "number" ? json.width : 0,
          height: typeof json.height === "number" ? json.height : 0,
          thumbUrl: thumbnailUrl(json.secure_url),
          thumbIsVideo: false,
        });
      } else {
        reject(new Error(json?.error?.message ?? `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    xhr.onabort = () => reject(abortError());
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}
