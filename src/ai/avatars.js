// 默认头像：设置页与聊天页共用。用户未上传时的兜底。
// - AI 默认：默认人设卡（kxyy-yuanyuan）用元元真人头像；其他自定义人设卡未设头像时用中性通用头像。
// - 我方默认用一个中性的用户剪影（内联 SVG，避免额外素材）。

export const DEFAULT_AI_AVATAR = "./assets/kxyy-avatar.jpeg";

/** 中性通用 AI 头像（自定义人设卡未设头像时的回退）。形状与用户头像一致，仅颜色不同。 */
export const DEFAULT_AI_AVATAR_NEUTRAL =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="gn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#a78bfa"/>
          <stop offset="1" stop-color="#7c3aed"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="32" fill="url(#gn)"/>
      <circle cx="32" cy="25" r="12" fill="#fff" opacity="0.92"/>
      <path d="M12 56c0-11 9-18 20-18s20 7 20 18z" fill="#fff" opacity="0.92"/>
    </svg>`
  );

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
