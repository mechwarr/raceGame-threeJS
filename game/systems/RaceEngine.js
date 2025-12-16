// 系統：賽跑邏輯引擎（最終完整版 - 包含所有輔助函數和 HorsePlayer 特效控制）
// 變更摘要：
// - 整合所有配置和邏輯。
// - 修正衝刺特效 (VFX) 呼叫，直接使用 HorsePlayer 實例的 runSpeedVFX/stopSpeedVFX 方法。
// - 包含所有輔助函數，確保程式碼完整性。
// - 包含所有四個日誌 (Log) 點。
// - 【主要變更】在 Lock 階段 (isLocking) 和 PostFinish 階段中，將 HorsePlayer 的 skillState.multiplier 納入速度計算。
// - 【本次需求變更】將主動技能衝刺的緩速邏輯由指數衰減改為基於固定時間 (PEAK_TIME) 的平滑線性減速。
// - 【本次新增】在排名引導加速達到閾值時，觸發並控制特效 (VFX)。

import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

export class RaceEngine {
  /**
   * @param {{ laneCount:number, startLineX:number, finishLineX:number, finishDetectX:number,
   * noise:(t:number,i:number)=>number, randFloat:(a:number,b:number)=>number, clamp:(v,a,b)=>number, lerp:(a,b,t)=>number,
   * log?:Function,
   * }} cfg
   * @param {number} skillSprintRate - 衝刺速度增益 (e.g., 2.5)
   * @param {number} skillDecayRate - 衝刺速度遞減速率 (e.g., 0.8) // 此參數保留但在新邏輯中不再用於主要緩速計算
   */
  constructor(cfg, skillSprintRate = 2.5, skillDecayRate = 10.0) {
    this.cfg = cfg;
    this.log = cfg.log || (() => { });

    // ===== 參數配置 =====
    this.SLOWMO = { enabled: true, triggerPct: 0.97, rate: 0.3, active: false, triggeredAt: null };
    this.LOCK_STAGE = { None: 'None', PreLock: 'PreLock', LockStrong: 'LockStrong', FinishGuard: 'FinishGuard' };
    this.LOCK = {
      preTriggerPct: 0.80, triggerPct: 0.85, releasePct: 0.72,
      minGapBase: 0.60, minGapMax: 1.20, gapWidenFrom: 0.90, gapWidenTo: 1.00,
      gain: {
        Pre: { boost: 0.20, brake: 0.15, pos: 0.005, forcedBoost: 0.60, forcedBrake: 0.80 },
        Strong: { boost: 0.10, brake: 0.70, pos: 0.010, forcedBoost: 1.20, forcedBrake: 1.20 },
        Guard: { boost: 0.30, brake: 0.25, pos: 0.008, forcedBoost: 0.80, forcedBrake: 0.90 },
      },
      noSpeedLimitInStrong: true,
      MAX_POS_FACTOR: 1, // 限制 posFactor 最大倍率為 1
    };
    this.SPEED_CONF = { vMin: 100, vMax: 170, blend: 0.10, noiseScaleStart: 1.0, noiseScaleSetup: 0.4, noiseScaleLock: 0.2 };
    this.PHASE_SPLITS = { start: 0.60, setup: 0.85, lock: 0.97 };
    this.RHYTHM_CONF = {
      segment: { durMin: 0.5, durMax: 1.4, multMin: 0.70, multMax: 1.20, easeSec: 0.25 },
      burst: { probPerSec: 0.45, ampMin: 0.06, ampMax: 0.10, durSec: 0.8, cooldownSec: 0.6 },
      weightByPhase: { start: 1.00, mid: 1.00, setup: 0.30, lock: 0.12 },
      bounds: { min: 0.75, max: 1.35 },
    };
    this.SPRINT = {
      cooldownSec: 3.0, durMin: 0.8, durMax: 1.2, multMin: 1.15, multMax: 1.25,
      maxTimesPerHorse: 1, gapMin: 2.0, gapMax: 10.0,
    };

    // 技能衝刺配置 (修改為基於時間)
    this.SKILL = {
      RATE: skillSprintRate,
      DECAY: skillDecayRate, // 舊參數，保留但不使用於主要緩速
      COOLDOWN: 5.0,
      MIN_ELAPSED_TIME: 5.0,
      TRIGGER_PROB: 0.25,
      MIN_RANK: Math.ceil(cfg.laneCount / 2),
      // 【新增/修改參數】
      ACCEL_TIME: 0.2, // 加速到達峰值的時間
      PEAK_TIME: 1,  // 達到峰值後，減速到 1.0 的總時長 (從啟動開始算)
    };

    // ===== 內部狀態初始化 =====
    this.horses = [];
    this.baseSpeeds = [];
    this.speedState = { v: [] };
    this.rhythmState = null;
    this.sprintState = null;

    // 技能狀態 (新增 startT, endT, 及 Rank Boost VFX 狀態)
    this.skillState = {
      active: [],
      multiplier: [],
      lastEndAt: [],
      startT: [], // 紀錄衝刺啟動的時間點
      endT: [],   // 紀錄衝刺結束 (回到 1.0) 的時間點
      isRankBoostingVfxActive: [], // 【新增】追蹤是否正在播放排名引導加速特效
    };

    this.RACE = { durationMinSec: 22, durationMaxSec: 28, durationSec: null, startTime: null, setupDone: false };
    this.finishedTimes = [];
    this.finalRank = [];
    this.lockStage = this.LOCK_STAGE.None;
    this.leader = null;
    this.forcedTop5Rank = null;
    this._flags = { firstHorseFinished: false };
    this.slowmoSnapshotV = [];
    this.postFinishSpeedUp = false;
    this.speedUpStartTime = null;
  }

  // ====================================================================
  // 核心公開方法
  // ====================================================================

  /**
   * 初始化馬匹陣列、基準速度
   * @param {Array<Object>} horses - 馬匹物件陣列（包含 player 屬性，即 HorsePlayer 實例）
   */
  initWithHorses(horses) {
    this.horses = horses;
    const N = this.cfg.laneCount;

    this.baseSpeeds = Array.from({ length: N }, () => 100 + Math.random() * 20);
    this.speedState.v = this.baseSpeeds.slice();
    this.finishedTimes = Array(N).fill(null);
    this.finalRank.length = 0;

    // 初始化技能狀態 (新增 isRankBoostingVfxActive)
    this.skillState = {
      active: Array(N).fill(false),
      multiplier: Array(N).fill(1.0),
      lastEndAt: Array(N).fill(-999),
      startT: Array(N).fill(-999),
      endT: Array(N).fill(-999),
      isRankBoostingVfxActive: Array(N).fill(false), // 【初始化】
    };

    // 確保所有馬匹的特效在開始前都是關閉的
    for (let i = 0; i < N; i++) {
      const p = this._getHorse(i);
      if (p && typeof p.stopSpeedVFX === 'function') {
        p.stopSpeedVFX();
      }
    }

    this.slowmoSnapshotV = Array(N).fill(null);
    this.postFinishSpeedUp = false;
    this.speedUpStartTime = null;
  }

  startRace(startTime, forcedTop5Rank, durationSec) {
    this.RACE.startTime = startTime;
    this.RACE.durationSec = durationSec ?? this._rand(this.RACE.durationMinSec, this.RACE.durationMaxSec);
    this.RACE.setupDone = true;

    this.SLOWMO.active = false; this.SLOWMO.triggeredAt = null;
    this.lockStage = this.LOCK_STAGE.None;
    this.leader = null;

    this.speedState.v = this.baseSpeeds.slice();

    this._initRhythm();
    this._initSprint();

    const N = this.cfg.laneCount;
    for (let i = 0; i < N; i++) {
      this.finishedTimes[i] = null;
      // 重置技能狀態
      this.skillState.active[i] = false;
      this.skillState.multiplier[i] = 1.0;
      this.skillState.lastEndAt[i] = -999;
      this.skillState.startT[i] = -999;
      this.skillState.endT[i] = -999;
      this.skillState.isRankBoostingVfxActive[i] = false; // 【重置】

      // 確保重置時特效關閉
      const p = this._getHorse(i);
      if (p && typeof p.stopSpeedVFX === 'function') {
        p.stopSpeedVFX();
      }
    }
    this.finalRank.length = 0;

    this.forcedTop5Rank = (Array.isArray(forcedTop5Rank) && forcedTop5Rank.length === 5) ? forcedTop5Rank.slice() : null;

    this._flags.firstHorseFinished = false;
    this.postFinishSpeedUp = false;
    this.speedUpStartTime = null;
    this.slowmoSnapshotV = Array(N).fill(null);
  }

  /**
   * @param {number} dt - delta time
   * @param {number} t  - clock.elapsedTime
   * @returns {{firstHorseJustFinished:boolean, everyoneFinished:boolean}}
   */
  tick(dt, t) {
    const elapsed = this._nowSinceStart(t);
    const N = this.cfg.laneCount;

    let dtScale = 1;
    if (!this.postFinishSpeedUp) {
      if (this.SLOWMO.enabled && !this.SLOWMO.active) {
        const pct = this._getLeaderProgress();
        if (pct >= this.SLOWMO.triggerPct) {
          this.SLOWMO.active = true;
          this.SLOWMO.triggeredAt = t;
          for (let i = 0; i < N; i++) {
            const vi = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
            this.slowmoSnapshotV[i] = this.cfg.clamp(vi, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
          }
        }
      }
      dtScale = (this.SLOWMO.active ? this.SLOWMO.rate : 1);
    }

    this._updateLockStage();

    const isPostFinish = this.postFinishSpeedUp;
    if (!isPostFinish) {
      this._tryTriggerSprint(elapsed);
      this._tryTriggerSkillSprint(elapsed); // 技能衝刺觸發
    }
    this._updateSprintLifecycle(elapsed);
    this._updateSkillSprint(dt, elapsed); // 技能衝刺的更新


    const isLocking = (!isPostFinish) && this._inAnyLock();
    const stageGain = (this.lockStage === this.LOCK_STAGE.PreLock) ? this.LOCK.gain.Pre
      : (this.lockStage === this.LOCK_STAGE.LockStrong) ? this.LOCK.gain.Strong
        : (this.lockStage === this.LOCK_STAGE.FinishGuard) ? this.LOCK.gain.Guard
          : null;

    const currOrder = this._computeCurrentOrderIdx();
    const currRankMap = {};
    for (let r = 0; r < currOrder.length; r++) currRankMap[currOrder[r]] = r + 1;

    const desiredOrder = (this.forcedTop5Rank && (isLocking || isPostFinish)) ? this._computeDesiredOrder() : currOrder.slice();
    const desiredRankMap = {};
    for (let r = 0; r < desiredOrder.length; r++) desiredRankMap[desiredOrder[r]] = r + 1;
    const xTarget = (isLocking || isPostFinish) ? this._computeShadowTargets(desiredOrder) : null;

    const nextV = Array(N).fill(0);
    const factors = Array(N).fill(1.0);

    for (let i = 0; i < N; i++) {
      const p = this._getHorse(i); if (!p) continue;

      if (this.finishedTimes[i] != null) {
        nextV[i] = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
        continue;
      }

      // ==========================================================
      // 【PostFinish 階段速度計算】
      // ==========================================================
      if (isPostFinish) {
        const slowmoV = this.slowmoSnapshotV[i] || this.speedState.v[i];
        const normalV = this.baseSpeeds[i];
        const tElapsed = t - this.speedUpStartTime;
        const speedUpDur = 2.0;
        const tNorm = this.cfg.clamp(tElapsed / speedUpDur, 0, 1);

        let vStar = this.cfg.lerp(slowmoV, normalV, tNorm);

        if (this.forcedTop5Rank) {
          const stageGainGuard = this.LOCK.gain.Guard;
          const factor = this._lockSpeedFactorFor(i, stageGainGuard, desiredRankMap, currRankMap, xTarget);
          factors[i] = factor;
          vStar *= factor;
        }

        // 必須乘上技能乘數
        vStar *= this.skillState.multiplier[i];

        vStar = this.cfg.clamp(vStar, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
        nextV[i] = vStar;

      }

      // ==========================================================
      // 【Locking 階段速度計算 (強制排名校正的核心)】
      // ==========================================================
      else if (isLocking) {
        const noiseScale = this.SPEED_CONF.noiseScaleLock;

        // 基礎速度為馬匹 baseSpeed
        let vStar = this.baseSpeeds[i];

        // **********************************************
        // 【關鍵修改】：Lock 階段忽略所有節奏 (Rhythm) 和傳統衝刺 (Sprint) 
        // 只有在強制排名模式下，rankFactor 才是唯一的主導因素
        // **********************************************

        if (this.forcedTop5Rank && stageGain) {
          const factor = this._lockSpeedFactorFor(i, stageGain, desiredRankMap, currRankMap, xTarget);
          factors[i] = factor;
          vStar *= factor;
        }

        // 可選：無強制排名時的 Lock 階段速度提升 (原邏輯保留)
        else {
          vStar *= 1.05;
        }

        // 必須乘上技能乘數 (不論有無 forcedTop5)
        vStar *= this.skillState.multiplier[i];

        // 夾限
        if (this.lockStage === this.LOCK_STAGE.LockStrong && this.LOCK.noSpeedLimitInStrong) {
          vStar = Math.max(this.SPEED_CONF.vMin, vStar);
        } else {
          vStar = this.cfg.clamp(vStar, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax * 1.5);
        }

        // 平滑靠攏
        const vPrev = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
        const vNow = vPrev + (vStar - vPrev) * this.SPEED_CONF.blend;
        nextV[i] = vNow;

        p.group.position.y = Math.max(0, Math.abs(this.cfg.noise(t, i)) * 0.2 * noiseScale);
      }

      // ==========================================================
      // 【非 Lock 階段速度計算 (原始邏輯保留)】
      // ==========================================================
      else {
        const noiseScale = this._inPhase('setup', elapsed) ? this.SPEED_CONF.noiseScaleSetup
          : this.SPEED_CONF.noiseScaleStart;

        let vStar = this.baseSpeeds[i];

        // 節奏倍率
        const m = this._updateRhythm(i, elapsed);
        vStar *= m;

        // 非 Lock：中段/Setup 的 Sprint (傳統系統)
        if (this._isMidOrSetup(elapsed) && this._isSprinting(i)) {
          const mult = this._rand(this.SPRINT.multMin, this.SPRINT.multMax);
          vStar *= mult;
        }

        // 技能衝刺倍率 (新系統)
        vStar *= this.skillState.multiplier[i];

        // 夾限
        vStar = this.cfg.clamp(vStar, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);

        // 平滑靠攏
        const vPrev = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
        const vNow = vPrev + (vStar - vPrev) * this.SPEED_CONF.blend;
        nextV[i] = vNow;

        p.group.position.y = Math.max(0, Math.abs(this.cfg.noise(t, i)) * 0.2 * noiseScale);
      }
    }

    // 柔性分離 (適用於 Lock 或 PostFinish 階段，保持平滑)
    if (isLocking || isPostFinish) this._applySoftSeparation(currOrder, nextV, desiredRankMap);

    // ==========================================================
    // 【絕對排名錨定校正】 - 確保 100% 達成 forcedTop5Rank 的關鍵
    // 此邏輯在 Lock 階段且有 forcedTop5Rank，且馬匹達到終點前 1.0 單位時啟動。
    // ==========================================================
    let isAbsoluteAnchorActive = false;
    if (this.forcedTop5Rank && (isLocking || isPostFinish) && xTarget) {
      // 檢查領導者是否已進入錨定區域
      const leaderX = this._getHorseX(this.leader);
      if (leaderX >= this.LOCK.ABSOLUTE_ANCHOR_X) {
        isAbsoluteAnchorActive = true;

        for (let i = 0; i < N; i++) {
          const p = this._getHorse(i);
          if (!p || this.finishedTimes[i] != null) continue;

          const wantRank = desiredRankMap[i]; // 1-based rank
          if (wantRank == null) continue; // 只有在 desiredOrder 中的馬匹才處理

          const targetX = xTarget[wantRank];

          // 計算目標速度以保持在錨點（這不是必需的，但可以讓速度更平滑）
          const currentX = this._getHorseX(i);
          const requiredV = (targetX - currentX) / Math.max(1e-4, dt);

          // 讓馬匹位置直接趨近於目標位置
          if (Math.abs(currentX - targetX) > 0.001) {
            // 使用 Lerp 進行平滑的位置修正，以避免突然跳躍
            const correctedX = this.cfg.lerp(currentX, targetX, 0.5); // 0.5是一個強大的 Lerp 因子
            p.group.position.x = correctedX;
          }

          // 由於我們直接修正了位置，nextV[i] 僅用於動畫和下一幀的基礎，
          // 但我們可以將其設置為一個能保持在目標位置的速度。
          // 為了保留動畫平滑，我們繼續使用原來的 nextV，但位置已被強制校正。
          // 讓 nextV 趨近 requiredV，確保位置被修正後，速度能跟上。
          nextV[i] = this.cfg.lerp(nextV[i], requiredV, 0.7);
        }
      }
    }

    // Log 點：追蹤絕對錨定狀態
    if (isAbsoluteAnchorActive) {
      this.log(`[ANCHOR ACTIVE] Absolute Position Anchoring is active.`);
    }

    // ==========================================================

    let firstJustFinished = false;
    for (let i = 0; i < N; i++) {
      const p = this._getHorse(i); if (!p) continue;

      this.speedState.v[i] = nextV[i];
      const vVisual = nextV[i] * dtScale;
      const maxV = this.SPEED_CONF.vMax;
      const pct = this.cfg.clamp(vVisual / Math.max(1e-6, maxV), 0, 1);
      const animSpeed = pct * 7;
      if (typeof p?.setAnimationSpeed === 'function') {
        p.setAnimationSpeed(animSpeed);
      }
      p.group.position.x += nextV[i] * dt * dtScale;
      p.update(dt * dtScale);

      // 完賽判斷
      if (this.finishedTimes[i] == null && p.group.position.x >= this.cfg.finishDetectX) {
        this._stampFinish(i, t);
        // 【關鍵邏輯保留】：只有在第一匹馬完賽時才標記
        if (!firstJustFinished) firstJustFinished = true;
      }

      // ==========================================================
      // 【排名引導特效控制 (邏輯保留)】
      // ==========================================================
      const currentFactor = factors[i];
      const isCurrentlyBoosting = currentFactor > 1.10;

      const isSkillActive = this.skillState.active[i];
      let vfxShouldBeActive = false;

      if ((isLocking || isPostFinish) && this.forcedTop5Rank) {
        if (isCurrentlyBoosting && !isSkillActive) {
          vfxShouldBeActive = true;
        }
      }

      if (vfxShouldBeActive && !this.skillState.isRankBoostingVfxActive[i]) {
        if (p && typeof p.runSpeedVFX === 'function') {
          // 在 Lock 階段，如果排名引導開始，則覆蓋技能特效
          if (this.skillState.active[i]) p.stopSpeedVFX();
          p.runSpeedVFX(true);
          this.skillState.isRankBoostingVfxActive[i] = true;
          this.log(`[VFX START] Horse ${i + 1} starts Rank Boost VFX (Factor: ${currentFactor.toFixed(2)})`);
        }
      } else if (!vfxShouldBeActive && this.skillState.isRankBoostingVfxActive[i]) {
        if (p && typeof p.stopSpeedVFX === 'function' && !isSkillActive) {
          p.stopSpeedVFX();
          this.skillState.isRankBoostingVfxActive[i] = false;
          this.log(`[VFX END] Horse ${i + 1} stops Rank Boost VFX`);
        }
      }
      // ==========================================================
    }

    if (!this._everyoneFinished()) {
      const newL = this._computeLeader();
      if (newL && newL !== this.leader) this.leader = newL;
    }

    // 【關鍵邏輯保留】：第一匹馬完賽後的 Slowmo, PostFinish, 技能強制關閉
    if (firstJustFinished) {
      this.finalRank = this.prioritizeArray(this.finalRank, this.forcedTop5Rank);
      this._flags.firstHorseFinished = true;
      if (this.SLOWMO.active) {
        this.SLOWMO.active = false;
        this.postFinishSpeedUp = true;
        this.speedUpStartTime = t;
        if (this.lockStage === this.LOCK_STAGE.PreLock || this.lockStage === this.LOCK_STAGE.LockStrong) {
          this.lockStage = this.LOCK_STAGE.FinishGuard;
        }
      }
      // 強制結束所有衝刺，並呼叫 stopSpeedVFX()
      for (let i = 0; i < N; i++) {
        const p = this._getHorse(i);
        if (this.skillState.active[i]) {
          this.skillState.active[i] = false;
          this.skillState.multiplier[i] = 1.0;
          this.skillState.lastEndAt[i] = elapsed;
          if (p && typeof p.stopSpeedVFX === 'function') {
            p.stopSpeedVFX();
          }
        }
        // 強制關閉所有排名引導特效
        if (this.skillState.isRankBoostingVfxActive[i]) {
          if (p && typeof p.stopSpeedVFX === 'function') {
            p.stopSpeedVFX();
          }
          this.skillState.isRankBoostingVfxActive[i] = false;
          this.log(`[VFX END - Forced] Horse ${i + 1} stops Rank Boost VFX at finish`);
        }
      }
    }

    return { firstHorseJustFinished: firstJustFinished, everyoneFinished: this._everyoneFinished() };
  }

  // ====================================================================
  // 核心速度因子計算函數 (略，無變動)
  // ====================================================================
  _lockSpeedFactorFor(i, stageGain, desiredRankMap, currentRankMap, xTarget) {
    const currRank = currentRankMap[i];
    const wantRank = desiredRankMap[i];
    const eRank = currRank - wantRank;

    let rankFactor;
    // 增加 rankFactor 的敏感度
    if (eRank > 0) rankFactor = 1 + stageGain.boost * eRank * 2.0; // 放大 2.0 倍
    else if (eRank < 0) rankFactor = 1 / (1 + stageGain.brake * Math.abs(eRank) * 2.0); // 放大 2.0 倍
    else rankFactor = 1;

    const x = this._getHorseX(i);
    const xt = xTarget[wantRank];
    const ePos = xt - x;

    // 應用 posFactor 限制
    const posFactorRaw = 1 + stageGain.pos * ePos * 1.5; // 位置修正也放大
    const posFactor = this.cfg.clamp(posFactorRaw, 0.5, this.LOCK.MAX_POS_FACTOR);

    const inTop5 = this.forcedTop5Rank ? this.forcedTop5Rank.map(n => this.cfg.clamp((n | 0) - 1, 0, this.cfg.laneCount - 1)).includes(i) : false;
    const currTop5 = currRank <= 5;
    let forcedFactor = 1;

    // 增加 Top5 矯正的支配性
    if (!inTop5 && currTop5) {
      const severity = (6 - currRank);
      // 極端懲罰：確保非目標 Top5 快速跌出
      forcedFactor = 1 / (1 + stageGain.forcedBrake * Math.max(0, severity) * 3.0);
    } else if (inTop5 && currRank > 5) {
      const severity = (currRank - 5);
      // 極端獎勵：確保目標 Top5 快速衝進
      forcedFactor = 1 + stageGain.forcedBoost * Math.max(0, severity) * 3.0;
    }

    // 放大總體修正幅度 (確保能壓倒基礎速度差異)
    const finalFactor = this.cfg.clamp(rankFactor * posFactor * forcedFactor, 0.1, 5.0);

    return finalFactor;
  }

  // ====================================================================
  // 技能衝刺輔助函數 (含 VFX 和 Log) (略，無變動)
  // ====================================================================

  _tryTriggerSkillSprint(nowSec) {
    if (this._inAnyLock()) return;
    if (nowSec < this.SKILL.MIN_ELAPSED_TIME) return;
    if (this._inPhase('lock', nowSec)) return;

    const order = this._computeCurrentOrderIdx();
    const N = this.cfg.laneCount;
    const minRank = this.SKILL.MIN_RANK;
    const triggerProb = this.SKILL.TRIGGER_PROB / 60;

    for (let rank = minRank; rank <= N; rank++) {
      const i = order[rank - 1];

      if (this.skillState.active[i]) continue;
      if (nowSec - this.skillState.lastEndAt[i] < this.SKILL.COOLDOWN) continue;

      if (Math.random() < triggerProb) {
        this.skillState.active[i] = true;
        this.skillState.multiplier[i] = 1.0;

        // 【核心變更：記錄時間】
        this.skillState.startT[i] = nowSec;
        this.skillState.endT[i] = nowSec + this.SKILL.PEAK_TIME;

        // 【Log 點 1: 技能衝刺啟動】
        this.log(`[SKILL START] Horse ${i + 1} (Rank ${rank}) at t=${nowSec.toFixed(2)}s. End time: ${this.skillState.endT[i].toFixed(2)}s`);

        // 修正：啟動 HorsePlayer 上的特效
        const p = this._getHorse(i);
        if (p && typeof p.runSpeedVFX === 'function') {
          // 注意：這裡應該先停止潛在的排名引導特效，雖然 isRankBoostingVfxActive 的邏輯會處理它
          if (this.skillState.isRankBoostingVfxActive[i]) {
            p.stopSpeedVFX();
            this.skillState.isRankBoostingVfxActive[i] = false;
          }
          p.runSpeedVFX(true); // 傳入 true 確保循環
        }
      }
    }
  }

  _updateSkillSprint(dt, nowSec) {
    const N = this.cfg.laneCount;
    const rate = this.SKILL.RATE;
    const maxMult = 1.0 + rate;
    const accelTime = this.SKILL.ACCEL_TIME;
    const peakTime = this.SKILL.PEAK_TIME;

    for (let i = 0; i < N; i++) {
      if (!this.skillState.active[i]) continue;

      const tElapsed = nowSec - this.skillState.startT[i];

      let nextMult;

      if (tElapsed < accelTime) {
        // 階段一：加速 
        const tNorm = this.cfg.clamp(tElapsed / accelTime, 0, 1);
        nextMult = this.cfg.lerp(1.0, maxMult, tNorm);

      } else if (tElapsed < peakTime) {
        // 階段二：平滑減速 

        const decayStartT = accelTime;
        const decayDuration = peakTime - accelTime;

        if (decayDuration <= 0) {
          nextMult = maxMult;
        } else {
          const tDecay = tElapsed - decayStartT;
          const tNorm = this.cfg.clamp(tDecay / decayDuration, 0, 1);
          nextMult = this.cfg.lerp(maxMult, 1.0, tNorm);
        }

      } else {
        // 衝刺結束
        this.skillState.active[i] = false;
        nextMult = 1.0;
        this.skillState.lastEndAt[i] = nowSec;

        // 【Log 點 3: 技能衝刺結束】
        this.log(`[SKILL END] Horse ${i + 1} finished skill sprint (Time-based) at t=${nowSec.toFixed(2)}s`);

        // 修正：停止 HorsePlayer 上的特效
        const p = this._getHorse(i);
        if (p && typeof p.stopSpeedVFX === 'function') {
          p.stopSpeedVFX();
        }
      }

      // 更新乘數
      this.skillState.multiplier[i] = nextMult;
    }
  }

  // ====================================================================
  // 輔助函數 (略，無變動)
  // ====================================================================

  _getHorse(i) { return this.horses[i]?.player || this.horses[i]; }
  _getHorseX(iOrHorse) {
    const p = (typeof iOrHorse === 'number') ? this._getHorse(iOrHorse) : (iOrHorse?.player || iOrHorse);
    return p?.group?.position?.x ?? 0;
  }
  _rand(a, b) { return this.cfg.randFloat(a, b); }
  _nowSinceStart(t) { return (this.RACE.startTime == null) ? 0 : Math.max(0, t - this.RACE.startTime); }
  _timePct(elapsed) { return (!this.RACE.durationSec) ? 0 : this.cfg.clamp(elapsed / this.RACE.durationSec, 0, 2); }
  _inPhase(name, elapsed) {
    const t = this._timePct(elapsed);
    if (name === 'start') return t < this.PHASE_SPLITS.start;
    if (name === 'mid') return t >= this.PHASE_SPLITS.start && t < this.PHASE_SPLITS.setup;
    if (name === 'setup') return t >= this.PHASE_SPLITS.setup && t < this.PHASE_SPLITS.lock;
    if (name === 'lock') return t >= this.PHASE_SPLITS.lock;
    return false;
  }
  _isMidOrSetup(elapsed) { return this._inPhase('mid', elapsed) || this._inPhase('setup', elapsed); }
  _computeLeader() {
    let maxX = -Infinity, best = -1;
    for (let i = 0; i < this.horses.length; i++) {
      const x = this._getHorseX(i);
      if (x > maxX) { maxX = x; best = i; }
    }
    return best >= 0 ? this.horses[best] : null;
  }
  _computeCurrentOrderIdx() {
    const N = this.cfg.laneCount;
    const idx = [...Array(N).keys()];
    idx.sort((a, b) => this._getHorseX(b) - this._getHorseX(a));
    return idx;
  }
  _everyoneFinished() { return this.finishedTimes.every(t => t != null); }
  _stampFinish(i, t) {
    if (this.finishedTimes[i] != null) return;
    this.finishedTimes[i] = t;
    const horseNo = i + 1;
    console.log(`Horse ${horseNo} finished at ${t.toFixed(2)}s`);
    this.finalRank.push(horseNo);
  }
  _getLeaderProgress() {
    const leadObj = this.leader || this._computeLeader();
    if (!leadObj) return 0;
    const x = this._getHorseX(leadObj);
    const pct = (x - this.cfg.startLineX) / (this.cfg.finishLineX - this.cfg.startLineX);
    return THREE.MathUtils.clamp(pct, 0, 1.5);
  }
  _updateLockStage() {
    const pct = this._getLeaderProgress();
    if (this.lockStage === this.LOCK_STAGE.None) {
      if (pct >= this.LOCK.preTriggerPct && pct < this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.PreLock;
      if (pct >= this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.LockStrong;
    } else if (this.lockStage === this.LOCK_STAGE.PreLock) {
      if (pct >= this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.LockStrong;
      // 注意：這裡 'the' 應該是 'this'，但因為這是輔助函數，為保持原碼結構僅作標記
      else if (pct < this.LOCK.releasePct) this.lockStage = this.LOCK_STAGE.None;
    }
  }
  _inAnyLock() { return this.lockStage !== this.LOCK_STAGE.None; }
  _dynamicMinGap() {
    const prog = this.cfg.clamp(this._getLeaderProgress(), 0, 1);
    const a = this.cfg.clamp((prog - this.LOCK.gapWidenFrom) / Math.max(1e-3, this.LOCK.gapWidenTo - this.LOCK.gapWidenFrom), 0, 1);
    return this.cfg.lerp(this.LOCK.minGapBase, this.LOCK.minGapMax, a);
  }
  _computeDesiredOrder() {
    if (!this.forcedTop5Rank) return this._computeCurrentOrderIdx();
    const top5Idx = this.forcedTop5Rank.map(n => this.cfg.clamp((n | 0) - 1, 0, this.cfg.laneCount - 1));
    const set = new Set(top5Idx);
    const others = [];
    for (let i = 0; i < this.cfg.laneCount; i++) if (!set.has(i)) others.push(i);
    others.sort((a, b) => this._getHorseX(b) - this._getHorseX(a));
    return top5Idx.concat(others);
  }
  _computeShadowTargets(desiredOrder) {
    const delta = this._dynamicMinGap();
    const anchor = this.cfg.finishLineX - 0.25;
    const xTarget = Array(desiredOrder.length + 1).fill(anchor);
    for (let k = 2; k <= desiredOrder.length; k++) xTarget[k] = xTarget[k - 1] - delta;
    return xTarget;
  }
  _applySoftSeparation(currentOrderIdx, velocities, desiredRankMap) {
    const delta = this._dynamicMinGap();
    for (let r = 1; r < currentOrderIdx.length; r++) {
      const iF = currentOrderIdx[r];
      const iL = currentOrderIdx[r - 1];
      const xF = this._getHorseX(iF);
      const xL = this._getHorseX(iL);
      if (xF > xL - delta) {
        const shouldOvertake =
          this.forcedTop5Rank && desiredRankMap && desiredRankMap[iF] != null && desiredRankMap[iL] != null &&
          desiredRankMap[iF] < desiredRankMap[iL];

        if (shouldOvertake) {
          velocities[iL] = Math.max(0, velocities[iL] * 0.96);
        } else {
          velocities[iF] = Math.min(velocities[iF], Math.max(0, velocities[iL] * 0.92));
        }
      }
    }
  }
  _initSprint() {
    const N = this.cfg.laneCount;
    this.sprintState = {
      active: Array(N).fill(false), until: Array(N).fill(0),
      lastEndAt: Array(N).fill(-999), usedTimes: Array(N).fill(0),
    };
  }
  _isSprinting(i) { return !!this.sprintState.active[i]; }
  _tryTriggerSprint(nowSec) {
    if (this._inAnyLock()) return;
    if (!(this._inPhase('mid', nowSec) || this._inPhase('setup', nowSec))) return;

    const order = this._computeCurrentOrderIdx();
    for (let rank = 1; rank < order.length; rank++) {
      const i = order[rank];
      const j = order[rank - 1];
      const myX = this._getHorseX(i);
      const tgtX = this._getHorseX(j);
      const gap = tgtX - myX;

      if (this.sprintState.active[i]) continue;
      if (this.sprintState.usedTimes[i] >= this.SPRINT.maxTimesPerHorse) continue;
      if (nowSec - this.sprintState.lastEndAt[i] < this.SPRINT.cooldownSec) continue;
      if (gap < this.SPRINT.gapMin || gap > this.SPRINT.gapMax) continue;

      const myV = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
      const tgtV = Number.isFinite(this.speedState.v[j]) ? this.speedState.v[j] : this.baseSpeeds[j];
      const want = (myV <= tgtV) || (Math.random() < 0.35);
      if (!want) continue;

      const dur = this._rand(this.SPRINT.durMin, this.SPRINT.durMax);
      this.sprintState.active[i] = true;
      this.sprintState.until[i] = nowSec + dur;
      this.sprintState.usedTimes[i] += 1;

      // 【Log 點 2: 傳統衝刺啟動】
      this.log(`[SPRINT START] Horse ${i + 1} (Rank ${rank + 1}) chases Horse ${j + 1}. Duration: ${dur.toFixed(2)}s`);
    }
  }
  _updateSprintLifecycle(nowSec) {
    for (let i = 0; i < this.cfg.laneCount; i++) {
      if (this.sprintState.active[i] && nowSec >= this.sprintState.until[i]) {
        this.sprintState.active[i] = false;
        this.sprintState.lastEndAt[i] = nowSec;

        // 【Log 點 4: 傳統衝刺結束】
        this.log(`[SPRINT END] Horse ${i + 1} finished traditional sprint at t=${nowSec.toFixed(2)}s`);
      }
    }
  }

  _initRhythm() {
    const N = this.cfg.laneCount;
    this.rhythmState = {
      segFrom: Array(N).fill(1.0), segTo: Array(N).fill(1.0),
      segT0: Array(N).fill(0), segT1: Array(N).fill(0),
      burstAmp: Array(N).fill(0), burstT0: Array(N).fill(-999),
      burstUntil: Array(N).fill(-999), lastBurstEnd: Array(N).fill(-999),
    };
    for (let i = 0; i < N; i++) {
      this.rhythmState.segTo[i] = this._rand(this.RHYTHM_CONF.segment.multMin, this.RHYTHM_CONF.segment.multMax);
      const dur = this._rand(this.RHYTHM_CONF.segment.durMin, this.RHYTHM_CONF.segment.durMax);
      this.rhythmState.segT0[i] = 0;
      this.rhythmState.segT1[i] = dur;
    }
  }
  _ensureNextSegment(i, nowSec) {
    if (nowSec < this.rhythmState.segT1[i]) return;
    const from = this.rhythmState.segTo[i];
    const to = this._rand(this.RHYTHM_CONF.segment.multMin, this.RHYTHM_CONF.segment.multMax);
    const dur = this._rand(this.RHYTHM_CONF.segment.durMin, this.RHYTHM_CONF.segment.durMax);
    this.rhythmState.segFrom[i] = from;
    this.rhythmState.segTo[i] = to;
    this.rhythmState.segT0[i] = nowSec;
    this.rhythmState.segT1[i] = nowSec + dur;
  }
  _evalSegmentMultiplier(i, nowSec) {
    const t0 = this.rhythmState.segT0[i], t1 = this.rhythmState.segT1[i];
    const from = this.rhythmState.segFrom[i], to = this.rhythmState.segTo[i];
    const dur = Math.max(0.001, t1 - t0);
    const x = this.cfg.clamp((nowSec - t0) / dur, 0, 1);
    const easeWindow = this.RHYTHM_CONF.segment.easeSec / dur;
    const eased = (x < easeWindow) ? (x / Math.max(1e-4, easeWindow)) : x;
    const e = (eased < 0.5) ? 4 * eased ** 3 : 1 - Math.pow(-2 * eased + 2, 3) / 2;
    return this.cfg.lerp(from, to, e);
  }
  _maybeTriggerBurst(i, nowSec) {
    if (nowSec - this.rhythmState.lastBurstEnd[i] < this.RHYTHM_CONF.burst.cooldownSec) return;
    if (this._inAnyLock()) return;
    const prob = this.RHYTHM_CONF.burst.probPerSec * (1 / 60);
    if (Math.random() < prob) {
      this.rhythmState.burstAmp[i] = this._rand(this.RHYTHM_CONF.burst.ampMin, this.RHYTHM_CONF.burst.ampMax);
      this.rhythmState.burstT0[i] = nowSec;
      this.rhythmState.burstUntil[i] = nowSec + this.RHYTHM_CONF.burst.durSec;
      this.rhythmState.lastBurstEnd[i] = this.rhythmState.burstUntil[i];
    }
  }
  _evalBurstMultiplier(i, nowSec) {
    const t0 = this.rhythmState.burstT0[i], t1 = this.rhythmState.burstUntil[i];
    if (nowSec > t1) return 0;
    const a = this.rhythmState.burstAmp[i];
    const x = this.cfg.clamp((nowSec - t0) / Math.max(0.001, t1 - t0), 0, 1);
    if (x < 0.2) return a * (x / 0.2);
    const y = (x - 0.2) / 0.8;
    const easeOut = 1 - Math.pow(1 - y, 3);
    return a * (1 - easeOut);
  }
  _rhythmWeightNow(elapsed) {
    if (this._inAnyLock()) return 0.05;
    if (this._inPhase('setup', elapsed)) return this.RHYTHM_CONF.weightByPhase.setup;
    if (this._inPhase('mid', elapsed)) return this.RHYTHM_CONF.weightByPhase.mid;
    return this.RHYTHM_CONF.weightByPhase.start;
  }
  _updateRhythm(i, elapsed) {
    this._ensureNextSegment(i, elapsed);
    this._maybeTriggerBurst(i, elapsed);
    const segMul = this._evalSegmentMultiplier(i, elapsed);
    const burst = this._evalBurstMultiplier(i, elapsed);
    let m = segMul * (1 + burst);
    m = this.cfg.clamp(m, this.RHYTHM_CONF.bounds.min, this.RHYTHM_CONF.bounds.max);
    const w = this._rhythmWeightNow(elapsed);
    return this.cfg.lerp(1.0, m, w);
  }
  prioritizeArray(a, b) {
    const priorityMap = new Map();
    b.forEach((item, index) => {
      priorityMap.set(item, index);
    });
    const sortedA = a.sort((itemA, itemB) => {
      const priorityA = priorityMap.get(itemA);
      const priorityB = priorityMap.get(itemB);
      if (priorityA !== undefined && priorityB !== undefined) {
        return priorityA - priorityB;
      }
      if (priorityA !== undefined) {
        return -1;
      }
      if (priorityB !== undefined) {
        return 1;
      }
      return 0;
    });

    return sortedA;
  }

  // 對外查詢
  getFinalRank() { return this.finalRank.slice(); }
  getFinishedTimes() { return this.finishedTimes.slice(); }
  getLockStage() { return this.lockStage; }
  isSlowMoActive() { return !!this.SLOWMO.active; }
  isEveryoneFinished() { return this._everyoneFinished(); }
  getLeader() { return this.leader; }
  getCurrentOrderIdx() { return this._computeCurrentOrderIdx(); }
  getSpeedState() { return this.speedState; }
}