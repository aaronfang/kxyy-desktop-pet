// ✰ 桌宠动画引擎 ✰
// 动画逻辑源自 webmeji（Lars de Rooij），改造为桌面单只桌宠、可切换角色。
// homepage: webmeji.neocities.org

/** 初始化：按角色 id 创建一只桌宠 */
async function initPet(petId) {
  const id = petId || window.DEFAULT_PET_ID;
  const config = window.PET_CONFIGS?.[id];
  if (!config) {
    console.warn(`config not found for pet: ${id}`);
    return;
  }
  await preloadImages(config);

  const creature = new Creature(`webmeji-${id}`, config);
  window.webmejiCreatures = [creature];
  window.currentPetId = id;
  window.dispatchEvent(new CustomEvent("webmeji:ready", { detail: { creatures: [creature] } }));
  return creature;
}

/** 切换角色：销毁旧的，加载新的 */
async function swapPet(petId) {
  for (const creature of window.webmejiCreatures || []) {
    creature.destroy?.();
  }
  window.webmejiCreatures = [];
  await initPet(petId);
}

window.initPet = initPet;
window.swapPet = swapPet;


// 全局帧缓存：预加载后的 Image 供 Canvas 绘制
const frameReady = new Map();
const FRAME_IMAGES = new Map();

function collectFrameUrls(config) {
  return Object.values(config)
    .flatMap(item => (item.frames && Array.isArray(item.frames)) ? item.frames : []);
}

async function preloadFrame(src) {
  if (frameReady.has(src)) return frameReady.get(src);
  const task = (async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });
    if (typeof img.decode === 'function') {
      try { await img.decode(); } catch (_) { /* ignore */ }
    }
    FRAME_IMAGES.set(src, img);
    return img;
  })();
  frameReady.set(src, task);
  return task;
}

function preloadImages(config) {
  const imagePaths = [...new Set(collectFrameUrls(config))];
  return Promise.all(imagePaths.map(preloadFrame));
}

// creature class -------------------------------------------------------
class Creature {
  resolveBoundsParent() {
    const sel = window.WEBMEJI_BOUNDS || this.spriteConfig?.BOUNDS;
    if (sel) {
      const el = typeof sel === "string" ? document.querySelector(sel) : sel;
      if (el) return el;
    }
    return document.body;
  }

  isBounded() {
    return this.boundsParent !== document.body;
  }

  boundsOrigin() {
    if (!this.isBounded()) return { left: 0, top: 0 };
    const rect = this.boundsParent.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  refreshBounds() {
    if (!this.isBounded()) {
      this.boundsWidth = window.innerWidth;
      this.boundsHeight = window.innerHeight;
    } else {
      this.boundsWidth = this.boundsParent.clientWidth;
      this.boundsHeight = this.boundsParent.clientHeight;
    }
    this.maxPos = Math.max(0, this.boundsWidth - this.containerWidth);
    this.bottomY = Math.max(0, this.boundsHeight - this.containerHeight);
  }

  clampPosition() {
    this.positionX = Math.max(0, Math.min(this.positionX, this.maxPos));
    this.positionY = Math.max(0, Math.min(this.positionY, this.bottomY));
  }

  constructor(containerId, spriteConfig) {
    this.currentEdge = 'bottom';

    this.boundsParent = this.resolveBoundsParent();

    // create div to hold the sprite image
    this.container = document.createElement('div');
    this.container.className = 'webmeji-container';
    if (this.isBounded()) {
      this.boundsParent.classList.add('webmeji-bounded');
      this.container.classList.add('webmeji-in-bounds');
    }
    this.boundsParent.appendChild(this.container);

    // Canvas 绘制精灵
    this.canvas = document.createElement('canvas');
    this.canvas.id = containerId;
    this.canvas.className = 'webmeji-sprite';
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this._frameUrl = '';
    this.container.appendChild(this.canvas);

    // store sprite configuration & randomize action sequence
    this.spriteConfig = spriteConfig;
    this.actionSequence = this.shuffle([...this.spriteConfig.ORIGINAL_ACTIONS]);
    this.currentActionIndex = 0;
    this.currentAction = null;
    this.frameTimer = null;
    this.dragFrameTimer = null;
    this.actionCompletionTimer = null;
    this.loopFrames = null;
    this.loopInterval = 0;
    this.loopFrameIndex = 0;
    this.loopFrameElapsed = 0;
    this.seqFrames = null;
    this.seqInterval = 0;
    this.seqFrameIndex = 0;
    this.seqElapsed = 0;
    this.seqLoopCount = 0;
    this.seqTotalLoops = 1;
    this.seqOnComplete = null;
    this.actionEndsAt = 0;
    this.actionEndCallback = null;
    this.reactionEndsAt = 0;
    this.reactionEndCallback = null;
    this.currentFrame = 0;
    this.direction = 1;
    this.facing = 'left';

    // starting states
    this.isDragging = false;
    this.isFalling = false;
    this.isPetting = false;
    this.isJumping = false;
    this.tripAfterFallActive = false;
    this.wasActionBeforePet = null;
    this.thinkingMode = false;
    this.speakingMode = false;
    this.reactionActive = false;
    this.reactionTimer = null;

    // pointer / drag detection
    this.isPointerDown = false;
    this._onWinPointerDown = () => { this.isPointerDown = true; };
    this._onWinPointerUp = () => { this.isPointerDown = false; };
    window.addEventListener('mousedown', this._onWinPointerDown);
    window.addEventListener('mouseup', this._onWinPointerUp);
    window.addEventListener('touchstart', this._onWinPointerDown, { passive: true });
    window.addEventListener('touchend', this._onWinPointerUp);

    // get container size
    const containerStyle = window.getComputedStyle(this.container);
    this.containerWidth = parseFloat(containerStyle.width);
    this.containerHeight = parseFloat(containerStyle.height);

    this.refreshBounds();

    // spawn at random bottom position within bounds
    this.positionX = Math.random() * this.maxPos;
    this.positionY = this.bottomY;

    this.container.style.left = `${this.positionX}px`;
    this.container.style.top = `${this.positionY}px`;

    this.forceWalkAfter = false;
    this.forceThinkAfter = false;

    this.syncCanvasSize();
    this.updateImageDirection();
    this.setFrameSrc(spriteConfig.walk.frames[0]);

    this.animate = this.animate.bind(this);

    this.enablePetInteraction();
    this.enableDragInteraction();

    this.currentAction = this.actionSequence[this.currentActionIndex];
    this.startAction(this.currentAction);
    this.lastTime = 0;
    this.animationFrameId = requestAnimationFrame(this.animate);

    this.resizeHandler = () => {
      const wasAtBottom = this.positionY >= this.bottomY - 4;
      const style = window.getComputedStyle(this.container);
      this.containerWidth = parseFloat(style.width);
      this.containerHeight = parseFloat(style.height);
      this.refreshBounds();
      if (wasAtBottom) {
        this.positionY = this.bottomY;
      } else {
        this.clampPosition();
      }
      this.syncCanvasSize();
      this.redrawFrame();
      this.applyEdgeOffset();
    };
    window.addEventListener('resize', this.resizeHandler);
    if (this.isBounded() && typeof ResizeObserver !== 'undefined') {
      this.boundsObserver = new ResizeObserver(() => this.resizeHandler());
      this.boundsObserver.observe(this.boundsParent);
    }
  }

  syncCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.containerWidth;
    const ch = this.containerHeight;
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setFrameSrc(url) {
    if (!url) return;
    this._frameUrl = url;
    this.paintFrame(url);
  }

  redrawFrame() {
    if (this._frameUrl) this.paintFrame(this._frameUrl);
  }

  paintFrame(url) {
    const image = FRAME_IMAGES.get(url);
    if (!image?.naturalWidth) return;
    const cw = this.containerWidth;
    const ch = this.containerHeight;
    const scale = cw / image.naturalWidth;
    const drawW = cw;
    const drawH = image.naturalHeight * scale;
    this.ctx.clearRect(0, 0, cw, ch);
    this.ctx.drawImage(image, 0, 0, drawW, drawH);
  }

  stopReactionModes() {
    this.thinkingMode = false;
    this.speakingMode = false;
    this.reactionActive = false;
    this.reactionEndsAt = 0;
    this.reactionEndCallback = null;
    if (this.reactionTimer) {
      clearTimeout(this.reactionTimer);
      this.reactionTimer = null;
    }
    this.resetAnimation();
  }

  startThinking() {
    if (this.isDragging || this.isFalling || this.isJumping) return;
    this.stopReactionModes();
    this.thinkingMode = true;
    this.reactionActive = true;
    this.currentAction = 'forcethink';
    if (this.currentEdge !== 'bottom') {
      this.positionY = this.bottomY;
      this.container.style.top = `${this.bottomY}px`;
    }
    this.currentEdge = 'bottom';
    this.updateEdgeClass();
    this._loopThinking();
  }

  _loopThinking() {
    if (!this.thinkingMode) return;
    const cfg = this.spriteConfig.forcethink;
    if (!cfg?.frames?.length) return;
    this.playLoopingFrames(cfg.frames, cfg.interval ?? 290);
  }

  stopThinking() {
    this.thinkingMode = false;
    if (!this.speakingMode) this.reactionActive = false;
    if (!this.thinkingMode && !this.speakingMode) this.resetAnimation();
  }

  startSpeaking() {
    if (this.isDragging || this.isFalling || this.isJumping) return;
    this.thinkingMode = false;
    this.speakingMode = true;
    this.reactionActive = true;
    this.currentAction = 'dance';
    if (this.currentEdge !== 'bottom') {
      this.positionY = this.bottomY;
      this.container.style.top = `${this.bottomY}px`;
    }
    this.currentEdge = 'bottom';
    this.updateEdgeClass();
    this._loopSpeaking();
  }

  _loopSpeaking() {
    if (!this.speakingMode) return;
    const cfg = this.spriteConfig.dance;
    if (!cfg?.frames?.length) return;
    this.playLoopingFrames(cfg.frames, cfg.interval ?? 200);
  }

  stopSpeaking() {
    this.speakingMode = false;
    if (!this.thinkingMode) this.reactionActive = false;
    if (!this.thinkingMode && !this.speakingMode) this.resetAnimation();
  }

  playReaction(action, { loops, durationMs } = {}) {
    if (this.isDragging || this.isFalling || this.isJumping) return;
    const config = this.spriteConfig[action];
    if (!config?.frames?.length) return;

    this.stopReactionModes();
    this.reactionActive = true;
    this.currentAction = action;
    if (this.currentEdge !== 'bottom') {
      this.positionY = this.bottomY;
      this.container.style.top = `${this.bottomY}px`;
    }
    this.currentEdge = 'bottom';
    this.updateEdgeClass();

    const effectiveLoops = loops ?? config.loops ?? 2;
    const interval = config.interval ?? 200;
    const totalMs = durationMs ?? Math.max(1200, interval * config.frames.length * effectiveLoops);
    let finished = false;

    const finish = () => {
      if (finished || !this.reactionActive) return;
      finished = true;
      this.reactionActive = false;
      this.reactionEndsAt = 0;
      this.reactionEndCallback = null;
      if (this.reactionTimer) {
        clearTimeout(this.reactionTimer);
        this.reactionTimer = null;
      }
      this.resetAnimation();
      if (!this.isDragging && !this.isFalling && !this.isJumping) {
        this.setNextAction();
      }
    };

    this.reactionEndsAt = performance.now() + totalMs;
    this.reactionEndCallback = finish;
    this.playAnimation(config.frames, interval, effectiveLoops, finish);
  }

  resumeIdle() {
    this.stopReactionModes();
    if (!this.isDragging && !this.isFalling && !this.isJumping) {
      this.setNextAction();
    }
  }

  shuffle(array) {
    for (let i=array.length-1; i>0; i--){
        const j = Math.floor(Math.random()*(i+1));
        [array[i],array[j]] = [array[j],array[i]];
    }
    return array;
  }

  updateImageDirection() {
    const flip = this.isSideEdge(this.currentEdge)
      ? this.facing === 'left'
      : this.facing === 'right';
    this.canvas.style.transform = flip ? 'scaleX(-1)' : 'scaleX(1)';
  }

  syncSideEdgeFacing() {
    if (this.currentEdge === 'left') this.facing = 'left';
    else if (this.currentEdge === 'right') this.facing = 'right';
    this.updateImageDirection();
  }

  setFacingFromDelta(dx) {
    if (dx && !this.isDragging) {
        this.facing = dx < 0 ? 'left' : 'right';
        this.updateImageDirection();
    }
  }

  resetAnimation() {
    clearInterval(this.frameTimer);
    clearTimeout(this.actionCompletionTimer);
    this.currentFrame = 0;
    this.frameTimer = null;
    this.actionCompletionTimer = null;
    this.loopFrames = null;
    this.loopInterval = 0;
    this.loopFrameIndex = 0;
    this.loopFrameElapsed = 0;
    this.seqFrames = null;
    this.seqInterval = 0;
    this.seqFrameIndex = 0;
    this.seqElapsed = 0;
    this.seqLoopCount = 0;
    this.seqTotalLoops = 1;
    this.seqOnComplete = null;
    this.actionEndsAt = 0;
    this.actionEndCallback = null;
  }

  scheduleActionEnd(ms, callback) {
    this.actionEndsAt = performance.now() + ms;
    this.actionEndCallback = callback;
  }

  stepLoopFrames(delta) {
    if (!this.loopFrames?.length || !this.loopInterval) return;
    if (this.loopFrames.length === 1) return;
    const dt = Math.min(delta, 0.25) * 1000;
    this.loopFrameElapsed += dt;
    while (this.loopFrameElapsed >= this.loopInterval) {
      this.loopFrameElapsed -= this.loopInterval;
      this.loopFrameIndex = (this.loopFrameIndex + 1) % this.loopFrames.length;
      this.setFrameSrc(this.loopFrames[this.loopFrameIndex]);
    }
  }

  stepSequenceFrames(delta) {
    if (!this.seqFrames?.length || !this.seqInterval) return;
    const dt = Math.min(delta, 0.25) * 1000;
    this.seqElapsed += dt;
    while (this.seqElapsed >= this.seqInterval) {
      this.seqElapsed -= this.seqInterval;
      const next = this.seqFrameIndex + 1;
      if (next >= this.seqFrames.length) {
        this.seqLoopCount++;
        if (this.seqLoopCount >= this.seqTotalLoops) {
          const cb = this.seqOnComplete;
          this.seqFrames = null;
          this.seqOnComplete = null;
          cb?.();
          return;
        }
        this.seqFrameIndex = 0;
      } else {
        this.seqFrameIndex = next;
      }
      this.setFrameSrc(this.seqFrames[this.seqFrameIndex]);
    }
  }

  tickScheduledEnds() {
    const now = performance.now();
    if (this.reactionEndsAt && now >= this.reactionEndsAt) {
      this.reactionEndsAt = 0;
      const reactionCb = this.reactionEndCallback;
      this.reactionEndCallback = null;
      if (this.reactionTimer) {
        clearTimeout(this.reactionTimer);
        this.reactionTimer = null;
      }
      reactionCb?.();
    }
    if (this.actionEndsAt && now >= this.actionEndsAt) {
      this.actionEndsAt = 0;
      const cb = this.actionEndCallback;
      this.actionEndCallback = null;
      cb?.();
    }
  }

  normalizeLoops(loops, fallback = 1) {
    if (typeof loops === 'number' && Number.isFinite(loops)) return loops;
    if (loops && typeof loops.loops === 'number') return loops.loops;
    return fallback;
  }

  isMovingAction(action = this.currentAction) {
    return ['walk', 'forced-walk', 'climbTop', 'climbSide'].includes(action);
  }

  playLoopingFrames(frames, interval) {
    if (!frames?.length) return;
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.seqFrames = null;
    this.seqOnComplete = null;
    this.loopFrames = frames;
    this.loopInterval = interval;
    this.loopFrameIndex = 0;
    this.loopFrameElapsed = 0;
    this.setFrameSrc(frames[0]);
  }

  ensureMovingAnimation() {
    const action = this.currentAction;
    if (!this.isMovingAction(action)) return;
    if (this.loopFrames?.length || this.seqFrames || this.reactionActive
      || this.isDragging || this.isFalling || this.isJumping) return;

    const config = action === 'walk' || action === 'forced-walk'
      ? this.spriteConfig.walk
      : this.spriteConfig[action];
    if (config?.frames?.length) {
      this.playLoopingFrames(config.frames, config.interval ?? 200);
    }
  }

  clearAllTimers() {
    this.resetAnimation();
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  destroy() {
    this.clearAllTimers();
    if (this.reactionTimer) clearTimeout(this.reactionTimer);
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.dragFrameTimer) clearInterval(this.dragFrameTimer);
    if (this.actionCompletionTimer) clearTimeout(this.actionCompletionTimer);
    if (this.boundsObserver) this.boundsObserver.disconnect();
    window.removeEventListener('mousedown', this._onWinPointerDown);
    window.removeEventListener('mouseup', this._onWinPointerUp);
    window.removeEventListener('touchstart', this._onWinPointerDown);
    window.removeEventListener('touchend', this._onWinPointerUp);
    window.removeEventListener('resize', this.resizeHandler);
    this.container?.remove();
  }

  // 暂停 / 恢复主循环（隐藏桌宠时停帧，避免空跑占用 CPU）
  pause() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  resume() {
    if (!this.animationFrameId) {
      this.lastTime = 0;
      this.animationFrameId = requestAnimationFrame(this.animate);
    }
  }

  isSideEdge(edge) { return edge === 'left' || edge === 'right'; }
  isNonBottomEdge(edge) { return edge !== 'bottom'; }

  updateEdgeClass() {
      this.container.classList.remove('edge-left','edge-right','edge-top');
      if (!this.isDragging) {
          this.currentEdge === 'left' && this.container.classList.add('edge-left');
          this.currentEdge === 'right' && this.container.classList.add('edge-right');
          this.currentEdge === 'top' && this.container.classList.add('edge-top');
      }
      this.applyEdgeOffset();
  }

  applyEdgeOffset() {
      if (this.isDragging) return this.container.style.cssText = `left:${this.positionX}px;top:${this.positionY}px`;

      const edgeDefaults = this.spriteConfig.EDGE_OFFSETS || {};
      const actionConfig = this.spriteConfig[this.currentAction] || {};
      const sideOutset = actionConfig.sideOutset ?? edgeDefaults.sideOutset ?? 0.28;
      const topOutset = actionConfig.topOutset ?? edgeDefaults.topOutset ?? 0.45;
      const w = this.containerWidth;
      const h = this.containerHeight;
      let offsetX = 0;
      let offsetY = 0;

      if (this.currentEdge === 'left') {
        offsetX = -w * (0.5 - sideOutset);
      } else if (this.currentEdge === 'right') {
        offsetX = w * (0.5 - sideOutset);
      } else if (this.currentEdge === 'top') {
        offsetY = -h * (0.5 - topOutset);
      }

      this.container.style.left = `${(this.positionX||0)+offsetX}px`;
      this.container.style.top  = `${(this.positionY||0)+offsetY}px`;
  }

  jumpToEdge(targetEdge) {
    if (this.isFalling || this.isPetting || this.isDragging || this.isJumping) return;
    if (!this.spriteConfig.ALLOWANCES.includes(targetEdge)) return;

    this.isJumping = true;
    this.currentAction = 'jump';
    this.resetAnimation();

    const jumpConfig = this.spriteConfig.jump;
    if (!jumpConfig) { this.isJumping = false; return; }

    const startX = this.positionX;
    const startY = this.positionY;
    let endX = startX;
    let endY = startY;

    switch (targetEdge) {
        case 'top':
            endY = 0;
            endX = Math.random() * this.maxPos;
            break;
        case 'left':
            endX = 0;
            endY = Math.random() * this.bottomY;
            break;
        case 'right':
            endX = this.maxPos;
            endY = Math.random() * this.bottomY;
            break;
    }

    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.hypot(dx, dy);

    if (distance === 0) { this.isJumping = false; return; }

    const duration = distance / this.spriteConfig.jumpspeed;
    const startTime = performance.now();

    this.playLoopingFrames(jumpConfig.frames, jumpConfig.interval ?? 200);

    const step = (time) => {
        if (this.isDragging) {
            this.isJumping = false;
            return;
        }

        const elapsed = (time - startTime) / 1000;
        const t = Math.min(elapsed / duration, 1);

        this.positionX = startX + dx * t;
        this.positionY = startY + dy * t;

        if (dx !== 0) this.setFacingFromDelta(dx);

        this.container.style.left = `${this.positionX}px`;
        this.container.style.top = `${this.positionY}px`;

        if (t < 1) {
            requestAnimationFrame(step);
        } else {
            this.resetAnimation();
            this.isJumping = false;
            this.currentEdge = targetEdge;
            this.updateEdgeClass();
            this.startEdgeIdle();
        }
    };
    requestAnimationFrame(step);
  }

  startEdgeIdle() {
    this.updateEdgeClass();
    if (this.currentEdge === 'top') this.startAction('hangstillTop');
    else if (this.isSideEdge(this.currentEdge)) {
      this.syncSideEdgeFacing();
      this.startAction('hangstillSide');
    }
  }

  edgeAction() {
    if(this.isJumping||this.isFalling) return;
    const choice=this.spriteConfig.EDGE_ACTIONS[Math.floor(Math.random()*this.spriteConfig.EDGE_ACTIONS.length)];
    choice==='hang'?this.startEdgeIdle():
    choice==='climb'?this.startAction(this.currentEdge==='top'?'climbTop':'climbSide'):
    choice==='fall'&&this.fallToBottom();
  }

  // user interactions ---------------------------------------------------
  enablePetInteraction() {
    if(!this.spriteConfig.ALLOWANCES?.includes('pet') || !this.spriteConfig.ALLOWANCES?.includes('bottom')) return;

    this.container.addEventListener('mouseenter',()=> {
        if(this.isFalling||this.isPointerDown||this.isPetting||this.isJumping||this.currentEdge!=='bottom') return;
        this.isPetting=true;
        this.wasActionBeforePet=this.currentAction;
        this.startPetAnimation();
    });
    this.container.addEventListener('mouseleave',()=> {
        if(this.isFalling||this.isPointerDown||this.isJumping||this.currentEdge==='top') return;
        this.isPetting=false;
        this.stopPetAnimation();
    });
  }

  enableDragInteraction() {
    if (!this.spriteConfig.ALLOWANCES?.includes('drag')) return;
    if (!this.spriteConfig.ALLOWANCES?.includes('bottom')) return;

    this.container.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.startDrag(e.clientX, e.clientY);
    });

    this.container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;
      let dragging = false;

      const onTouchMove = (ev) => {
        if (dragging) return;
        const t = ev.touches[0];
        if (!t) return;
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.hypot(dx, dy) < 16) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.15) return;
        dragging = true;
        cleanup();
        ev.preventDefault();
        this.startDrag(t.clientX, t.clientY);
      };

      const onTouchEnd = () => cleanup();

      const cleanup = () => {
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        window.removeEventListener('touchcancel', onTouchEnd);
      };

      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd);
      window.addEventListener('touchcancel', onTouchEnd);
    }, { passive: true });

    this.startDrag = (clientX, clientY) => {
    this.resetAnimation();

    this.isDragging = true;
    this.tripAfterFallActive = false;
    this.isJumping = false;
    this.isFalling = false;
    this.isPetting = false;
    this.stopReactionModes();

    this.currentAction = 'drag';
    this.canvas.style.transform = this.facing === 'left' ? 'scaleX(1)' : 'scaleX(-1)';

    if (this.dragFrameTimer) clearInterval(this.dragFrameTimer);
    this.dragFrameTimer = null;

    const dragConfig = this.spriteConfig.drag;
    if (dragConfig?.frames?.length) {
      this.playLoopingFrames(dragConfig.frames, dragConfig.interval ?? 160);
    }

    const rect = this.container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;

    const onPointerMove = (e) => {
        e.preventDefault();

        const cx = e.clientX ?? e.touches?.[0].clientX;
        const cy = e.clientY ?? e.touches?.[0].clientY;
        const origin = this.boundsOrigin();

        this.positionX = cx - offsetX - origin.left;
        this.positionY = cy - offsetY - origin.top;
        this.clampPosition();

        this.container.style.left = this.positionX + 'px';
        this.container.style.top  = this.positionY + 'px';
    };

    const onPointerUp = () => {
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('touchmove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
        window.removeEventListener('touchend', onPointerUp);

        this.isDragging = false;
        this.isFalling = false;

        if (this.dragFrameTimer) {
            clearInterval(this.dragFrameTimer);
            this.dragFrameTimer = null;
        }
        this.loopFrames = null;

        this.resetAnimation();
        this.fallToBottom();

        if (!this.animationFrameId) {
          this.animationFrameId = requestAnimationFrame(this.animate);
        }
    };

    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);
  };
  }

  // falling and recovery -------------------------------------------------
  fallToBottom(fallSpeed=this.spriteConfig.fallspeed){
    if(this.isFalling) return;
    this.tripAfterFallActive = false;
    this.isFalling = true;
    this.currentEdge='bottom';
    this.updateEdgeClass();
    this.resetAnimation();

    const cfg=this.spriteConfig.falling; if(!cfg) return;

    this.playLoopingFrames(cfg.frames, cfg.interval);

    const startY=this.positionY, endY=this.bottomY, distance=endY-startY;
    if(distance<=0){
      this.resetAnimation();
      this.positionY=endY;
      this.container.style.top=`${endY}px`;
      return this.playTripAfterFall();
    }

    const startTime=performance.now();
    const step = (time) => {
      if (this.isDragging) {
          this.resetAnimation();
          if (!this.animationFrameId) {
            this.animationFrameId = requestAnimationFrame(this.animate);
          }
          return;
      }

      const elapsed = (time - startTime) / 1000;
      const deltaY = fallSpeed * elapsed;
      this.positionY = Math.min(startY + deltaY, endY);
      this.container.style.top = `${this.positionY}px`;

      if (this.positionY < endY) {
          requestAnimationFrame(step);
      } else {
          this.resetAnimation();
          this.positionY = endY;
          this.container.style.top = `${endY}px`;
          this.playTripAfterFall();
      }
    };
    requestAnimationFrame(step);
  }

  playTripAfterFall() {
    const tripConfig = this.spriteConfig.fallen;
    if (!tripConfig) {
        this.resumeAfterFallen();
        return;
    }

    this.tripAfterFallActive = true;
    const totalFrames = tripConfig.frames.length;
    this.setFrameSrc(tripConfig.frames[0]);
    const fallenOffsetY = (tripConfig.offsetY ?? 0) * this.containerHeight;
    if (fallenOffsetY) {
      this.container.style.top = `${this.positionY + fallenOffsetY}px`;
    }

    this.playAnimation(tripConfig.frames, tripConfig.interval, 1, () => {
      this.setFrameSrc(tripConfig.frames[totalFrames - 1]);
      this.scheduleActionEnd(this.spriteConfig.gettingupspeed, () => {
        if (this.tripAfterFallActive) this.resumeAfterFallen();
      });
    });
  }

  resumeAfterFallen() {
    if(this.isDragging) return;
    this.tripAfterFallActive = false;
    this.isFalling = false;
    this.isPetting = false;
    this.resetAnimation();
    this.container.style.top = `${this.positionY}px`;
    this.lastTime = performance.now();
    this.setNextAction();
    if (!this.animationFrameId) {
      this.animationFrameId = requestAnimationFrame(this.animate);
    }
  }

  // action selection and animation --------------------------------------------------
  setNextAction() {
    if (this.reactionActive) return;
    if (this.isDragging || this.isFalling ) return;

    this.resetAnimation();

    if (['top', 'left', 'right'].includes(this.currentEdge)) {
        this.edgeAction();
        return;
    }

    // 兜底：currentEdge 是 'bottom' 但物理位置不在底部（可能被 reaction 方法误设状态），
    // 此时先下落到底部，避免在非底部位置执行 walk 等地面动作。
    if (this.currentEdge === 'bottom' && this.positionY < this.bottomY - 4) {
      this.fallToBottom();
      return;
    }

    if (!this.isJumping && this.positionY >= this.bottomY) {
      if (Math.random() < this.spriteConfig.JUMP_CHANCE) {
        const edges = ['top', 'left', 'right']
          .filter(e => this.spriteConfig.ALLOWANCES.includes(e));

        if (edges.length) {
          const target = edges[Math.floor(Math.random() * edges.length)];
          this.jumpToEdge(target);
          return;
        }
      }
    }

    if (this.forceWalkAfter) {
      this.forceWalkAfter = false;
      this.startForcedWalk();
      return;
    }

    if (this.forceThinkAfter) {
      this.forceThinkAfter = false;
      this.startForceThink();
      return;
    }

    this.currentActionIndex++;
    if (this.currentActionIndex >= this.actionSequence.length) {
      this.currentActionIndex = 0;
      this.actionSequence = this.shuffle([...this.spriteConfig.ORIGINAL_ACTIONS]);
    }

    this.currentAction = this.actionSequence[this.currentActionIndex];
    this.startAction(this.currentAction);
  }

  startForcedWalk() {
    const { frames, interval } = this.spriteConfig.walk;
    const loops = this.normalizeLoops(this.spriteConfig.forcewalk, 6);
    this.currentAction = 'forced-walk';
    this.resetAnimation();
    this.playLoopingFrames(frames, interval);
    this.scheduleActionEnd(
      interval * frames.length * loops,
      () => this.setNextAction(),
    );
  }

  startForceThink() {
    const { frames, interval, loops } = this.spriteConfig.forcethink;
    this.currentAction = 'force-think';
    this.playAnimation(frames, interval, loops, () => this.setNextAction());
  }

  startPetAnimation() {
    this.resetAnimation();

    const petConfig = this.spriteConfig.pet;
    if (!petConfig) return;

    this.currentAction = 'pet';
    this.playLoopingFrames(petConfig.frames, petConfig.interval ?? 250);
  }

  stopPetAnimation() {
    this.resetAnimation();
    this.currentAction = this.wasActionBeforePet || 'sit';
    this.wasActionBeforePet = null;
    this.setNextAction();
  }

  startAction(action) {
    if (this.isDragging || this.isFalling ) return;
    this.currentAction = action;
    this.resetAnimation();

    if (action === 'climbTop') {
      this.direction = Math.random() < 0.5 ? -1 : 1;
      this.updateImageDirection();
    }
    if (action === 'climbSide') {
      this.direction = Math.random() < 0.5 ? -1 : 1;
      this.syncSideEdgeFacing();
    }
    if (this.isNonBottomEdge(this.currentEdge)) {
      this.applyEdgeOffset();
    }
    if (this.isJumping) {
      this.animationFrameId = requestAnimationFrame(this.animate);
      return;
    }

    const config = this.spriteConfig[action];
    if (!config) return;

    const { frames, interval, loops = 1 } = config;

    if (action === 'hangstillSide' || action === 'hangstillTop') {
      const duration = config.randomizeDuration
        ? Math.random() * (config.max - config.min) + config.min
        : interval * loops;
      this.setFrameSrc(frames[0]);
      this.applyEdgeOffset();
      this.scheduleActionEnd(duration, () => {
        this.forceWalkAfter = true;
        this.setNextAction();
      });
      return;
    }

    if (action === 'climbTop' || action === 'climbSide') {
      this.playLoopingFrames(frames, interval);
      const duration = config.climbDuration
        ?? Math.max(2000, interval * this.normalizeLoops(loops, 1) * Math.max(frames.length, 1));
      this.scheduleActionEnd(duration, () => this.setNextAction());
      return;
    }

    if (action === 'walk') {
      this.playLoopingFrames(frames, interval);
      this.scheduleActionEnd(
        interval * frames.length * loops,
        () => this.setNextAction(),
      );
      return;
    }

    this.playAnimation(frames, interval, loops, () => {
      if (action === 'spin') {
        this.direction *= -1;
        this.facing = this.facing === 'left' ? 'right' : 'left';
        this.updateImageDirection();
      }

      if (['trip', 'spin', 'sit'].includes(action)) this.forceWalkAfter = true;
      if (action === 'dance') this.forceThinkAfter = true;

      this.setNextAction();
    });
  }

  playAnimation(frames, interval, loops, onComplete){
    if (!frames?.length) {
      onComplete?.();
      return;
    }
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.loopFrames = null;
    this.seqFrames = frames;
    this.seqInterval = interval;
    this.seqTotalLoops = this.normalizeLoops(loops, 1);
    this.seqLoopCount = 0;
    this.seqFrameIndex = 0;
    this.seqElapsed = 0;
    this.seqOnComplete = onComplete;
    this.currentFrame = 0;
    this.setFrameSrc(frames[0]);
  }

  // main animation loop --------------------------------------------------
  animate(time) {
    if (!this.lastTime) this.lastTime = time;
    const delta = Math.min((time - this.lastTime) / 1000, 0.25);
    this.lastTime = time;

    this.stepLoopFrames(delta);
    this.stepSequenceFrames(delta);
    this.tickScheduledEnds();

    if (this.reactionActive || this.isDragging || this.isFalling || this.isJumping) {
        this.animationFrameId = requestAnimationFrame(this.animate);
        return;
    }
    this.ensureMovingAnimation();
    const movingActions = ['walk', 'forced-walk', 'climbTop'];
    if (movingActions.includes(this.currentAction)) {
        const dx = this.direction * this.spriteConfig.walkspeed * delta;
        this.positionX += dx;
        this.setFacingFromDelta(dx);

        if (this.positionX <= 0) {
            this.positionX = 0;
            this.direction = 1;
            this.facing = 'right';
            this.updateImageDirection();
        } else if (this.positionX >= this.maxPos) {
            this.positionX = this.maxPos;
            this.direction = -1;
            this.facing = 'left';
            this.updateImageDirection();
        }
        this.applyEdgeOffset();
    }

    if (this.currentAction === 'climbSide') {
      this.positionY += this.direction * this.spriteConfig.walkspeed * delta;
      this.syncSideEdgeFacing();

      const maxY = this.bottomY;
      if (this.positionY <= 0) {
        this.positionY = 0;
        this.direction = 1;
      } else if (this.positionY >= maxY) {
        this.positionY = maxY;
        this.direction = -1;
      }
      this.applyEdgeOffset();
    }
    this.animationFrameId = requestAnimationFrame(this.animate);
  }
}
