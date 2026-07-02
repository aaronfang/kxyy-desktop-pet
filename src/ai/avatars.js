// 默认头像：设置页与聊天页共用。用户未上传时的兜底。
// - AI 默认用打包进工程的元元真人头像（用户也可在设置里自行更换）。
// - 我方默认用一个中性的用户剪影（内联 SVG，避免额外素材）。

export const DEFAULT_AI_AVATAR = "./assets/kxyy-avatar.jpeg";

export const DEFAULT_USER_AVATAR =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8b9dff"/>
          <stop offset="1" stop-color="#6a5acd"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="32" fill="url(#g)"/>
      <circle cx="32" cy="25" r="12" fill="#fff" opacity="0.92"/>
      <path d="M12 56c0-11 9-18 20-18s20 7 20 18z" fill="#fff" opacity="0.92"/>
    </svg>`
  );
