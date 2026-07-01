// 桌宠角色配置
// 素材目录：./assets/pets/<角色id>/<动作>/<动作>_NN.png
// 上游动画逻辑源自 webmeji：https://github.com/lars-rooij/webmeji
//
// 新增角色：把素材放到 assets/pets/<id>/，在本文件用 registerPet 注册，
// 并在 shared/roster.json 里加一行 { "id": "...", "label": "..." }。

const WEBMEJI_BASE = "./assets/pets";

/** 各动作默认帧数（kxyy-cyber 基准）；新角色用 frames 覆盖 */
const DEFAULT_PET_FRAMES = {
  walk: 9,
  sit: 4,
  dance: 5,
  trip: 6,
  forcethink: 3,
  pet: 3,
  drag: 2,
  falling: 2,
  fallen: 3,
  climbSide: 2,
  climbTop: 2,
  hangstillSide: 1,
  hangstillTop: 1,
  jump: 1,
};

/** 生成某角色某动作的帧路径列表 */
function petFrames(slug, action, count) {
  const prefix = `${WEBMEJI_BASE}/${slug}/${action}/${action}_`;
  return Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}.png`,
  );
}

/**
 * 创建桌宠配置。
 * @param {string} slug - 素材目录名，对应 assets/pets/<slug>/
 * @param {object} options - frames 覆盖各动作帧数，其余键覆盖顶层字段或单个动作块。
 */
function createPetConfig(slug, options = {}) {
  const { frames: frameOverrides = {}, ...overrides } = options;
  const frameCounts = { ...DEFAULT_PET_FRAMES, ...frameOverrides };
  const f = (action) => petFrames(slug, action, frameCounts[action]);
  const WALK = f("walk");
  const CLIMB_SIDE = f("climbSide");
  const CLIMB_TOP = f("climbTop");
  const HANG_STILL_SIDE = f("hangstillSide");
  const HANG_STILL_TOP = f("hangstillTop");

  const config = {
    ALLOWANCES: ["pet", "drag", "bottom", "top", "left", "right"],

    // 边缘默认偏移（0~0.5，越大越往舞台内缩）
    EDGE_OFFSETS: {
      sideOutset: 0.28,
      topOutset: 0.45,
    },

    walkspeed: 50,
    fallspeed: 150,
    jumpspeed: 200,
    gettingupspeed: 3500,

    walk: { frames: WALK, interval: 120, loops: 6 },
    stand: { frames: [WALK[0]], interval: 1000, loops: 1 },
    sit: { frames: f("sit"), interval: 250, loops: 1 },
    spin: { frames: [WALK[0]], interval: 150, loops: 3 },
    dance: { frames: f("dance"), interval: 200, loops: 2 },
    trip: { frames: f("trip"), interval: 200, loops: 1 },

    forcewalk: { loops: 6 },
    forcethink: { frames: f("forcethink"), interval: 290, loops: 2 },

    pet: { frames: f("pet"), interval: 250 },
    drag: { frames: f("drag"), interval: 160 },

    falling: { frames: f("falling"), interval: 200, loops: 2 },
    fallen: { frames: f("fallen"), interval: 200, loops: 1, offsetY: 0.15 },

    ORIGINAL_ACTIONS: [
      "walk", "walk", "walk", "walk", "walk", "walk",
      "spin", "spin", "spin",
      "sit", "sit",
      "dance", "dance", "dance", "dance", "dance",
      "trip",
    ],

    EDGE_ACTIONS: [
      "hang", "hang",
      "climb", "climb", "climb", "climb", "climb",
      "fall",
    ],

    JUMP_CHANCE: 0.1,

    climbSide: { frames: CLIMB_SIDE, interval: 300, loops: 2, climbDuration: 3500 },
    hangstillSide: {
      frames: HANG_STILL_SIDE, interval: 200, loops: 2,
      randomizeDuration: true, min: 3000, max: 11000,
    },
    climbTop: { frames: CLIMB_TOP, interval: 400, loops: 8, climbDuration: 4500 },
    hangstillTop: {
      frames: HANG_STILL_TOP, interval: 200, loops: 2,
      randomizeDuration: true, min: 3000, max: 11000,
    },
    jump: { frames: f("jump"), interval: 200 },
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && config[key] && typeof config[key] === "object") {
      config[key] = { ...config[key], ...value };
    } else {
      config[key] = value;
    }
  }

  return config;
}

// --- 角色注册 ---
window.PET_CONFIGS = {};

function registerPet(id, options) {
  window.PET_CONFIGS[id] = createPetConfig(id, options);
}

registerPet("kxyy-cyber");

registerPet("kxyy-miaojiang", {
  frames: {
    walk: 4,
    dance: 13,
    trip: 4,
    forcethink: 9,
    pet: 8,
    drag: 3,
    fallen: 9,
    falling: 6,
    climbTop: 3,
  },
  walk: { interval: 140, loops: 8 },
  dance: { interval: 110, loops: 1 },
  trip: { interval: 220 },
  forcethink: { interval: 180, loops: 1 },
  pet: { interval: 200 },
  drag: { interval: 160 },
  falling: { interval: 130 },
  fallen: { interval: 150, offsetY: 0.04 },
  climbTop: { interval: 220, loops: 6, climbDuration: 4000, topOutset: 0.19 },
  climbSide: { interval: 280, climbDuration: 3200, sideOutset: 0.32 },
  hangstillSide: { sideOutset: 0.2 },
  hangstillTop: { topOutset: 0.19 },
  EDGE_OFFSETS: { sideOutset: 0.26, topOutset: 0.19 },
});

// 默认角色（可被主进程设置覆盖）
window.DEFAULT_PET_ID = "kxyy-miaojiang";
